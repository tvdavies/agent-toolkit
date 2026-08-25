#!/usr/bin/env bash
#
# team-pr-status.sh — Per-reviewer breakdown of open PRs across the team.
#
# Shows WHO needs to look at WHICH PRs, grouped by reviewer.
# For each team member, lists PRs awaiting their review with priority and status.
#
# Dependencies: gh, jq, curl
# Config:       Reads LINEAR_API_KEY from env, or falls back to ~/.config/linear-cli/config.toml
#               Reads team members from TEAM_MEMBERS env or uses defaults
#
# Usage:
#   ./scripts/team-pr-status.sh              # default: last 7 days
#   ./scripts/team-pr-status.sh --days 14    # last 14 days
#   ./scripts/team-pr-status.sh --json       # raw JSON output

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
DAYS=7
OUTPUT_FORMAT="table"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)  DAYS="$2"; shift 2 ;;
    --json)  OUTPUT_FORMAT="json"; shift ;;
    --slack) OUTPUT_FORMAT="slack"; shift ;;
    --help|-h)
      echo "Usage: $0 [--days N] [--json] [--slack]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Team members (override via TEAM_MEMBERS env, comma-separated) ─────────
if [[ -n "${TEAM_MEMBERS:-}" ]]; then
  IFS=',' read -ra MEMBERS <<< "$TEAM_MEMBERS"
else
  MEMBERS=("corixdean" "GSasu" "jaythegeek" "tvdavies")
fi

# ── Temp dir ──────────────────────────────────────────────────────────────────
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# ── Resolve Linear API key ───────────────────────────────────────────────────
if [[ -z "${LINEAR_API_KEY:-}" ]]; then
  LINEAR_CONFIG="$HOME/.config/linear-cli/config.toml"
  if [[ -f "$LINEAR_CONFIG" ]]; then
    LINEAR_API_KEY=$(grep 'api_key' "$LINEAR_CONFIG" | head -1 | sed 's/.*= *"\(.*\)"/\1/')
  fi
fi

HAS_LINEAR=false
if [[ -n "${LINEAR_API_KEY:-}" ]]; then
  HAS_LINEAR=true
fi

# ── Detect repo ──────────────────────────────────────────────────────────────
REPO=""
if git rev-parse --is-inside-work-tree &>/dev/null; then
  REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
fi

if [[ -z "$REPO" ]]; then
  echo "Error: Not inside a git repository. Run from a repo or add --repo support." >&2
  exit 1
fi

# ── Bot filter ────────────────────────────────────────────────────────────────
cat > "$TMPDIR/exclude_bots.jq" << 'JQEOF'
map(select(
  . != "coderabbitai" and
  . != "coderabbitai[bot]" and
  . != "copilot-pull-request-reviewer" and
  . != "copilot-pull-request-reviewer[bot]" and
  . != "Copilot" and
  . != "github-actions" and
  . != "github-actions[bot]" and
  . != "snyk-bot" and
  . != "socket-security[bot]" and
  . != "vercel[bot]" and
  . != "dependabot[bot]"
))
JQEOF

# ── 1. Fetch all open non-draft PRs ─────────────────────────────────────────
CUTOFF=$(date -u -d "-${DAYS} days" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -v-${DAYS}d +%Y-%m-%dT%H:%M:%SZ)

echo "Fetching open PRs from the last ${DAYS} days..." >&2

gh pr list \
  --state open \
  --json number,title,author,createdAt,reviewRequests,reviews,url,headRefName,body,isDraft \
  --limit 100 > "$TMPDIR/all_prs.json"

# Filter to non-draft PRs within date range, exclude bot authors
jq --arg cutoff "$CUTOFF" '[.[] | select(
  .createdAt > $cutoff and
  .isDraft != true and
  (.author.login | test("dependabot|snyk|renovate"; "i") | not)
)]' "$TMPDIR/all_prs.json" > "$TMPDIR/prs.json"

PR_COUNT=$(jq 'length' "$TMPDIR/prs.json")
echo "Found ${PR_COUNT} open PRs." >&2

if [[ "$PR_COUNT" -eq 0 ]]; then
  echo "No open PRs in the last ${DAYS} days."
  exit 0
fi

# ── 2. Extract Linear issue data (for priority) ─────────────────────────────
echo '{}' > "$TMPDIR/linear_data.json"

if [[ "$HAS_LINEAR" == "true" ]]; then
  LINEAR_IDS=$(jq -r '
    [.[] |
      ((.headRefName // "") | ascii_upcase | [scan("LLE-[0-9]+")] | .[]),
      ((.title // "")       | ascii_upcase | [scan("LLE-[0-9]+")] | .[]),
      ((.body // "")        | ascii_upcase | [scan("LLE-[0-9]+")] | .[])
    ] | unique | .[]
  ' "$TMPDIR/prs.json")

  ISSUE_NUMBERS=$(echo "$LINEAR_IDS" | sed 's/LLE-//' | sort -un | tr '\n' ',' | sed 's/,$//')

  if [[ -n "$ISSUE_NUMBERS" ]]; then
    echo "Fetching Linear priorities..." >&2

    GRAPHQL_QUERY=$(jq -n --arg nums "$ISSUE_NUMBERS" '{
      query: ("query { issues(filter: { team: { key: { eq: \"LLE\" } }, number: { in: [" + $nums + "] } }, first: 50) { nodes { identifier title priority priorityLabel state { name } } } }")
    }')

    curl -s -X POST https://api.linear.app/graphql \
      -H "Authorization: $LINEAR_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$GRAPHQL_QUERY" > "$TMPDIR/linear_response.json"

    jq '
      [.data.issues.nodes[]? | {
        key: .identifier,
        value: {
          priority: .priority,
          priorityLabel: .priorityLabel,
          state: .state.name
        }
      }] | from_entries
    ' "$TMPDIR/linear_response.json" > "$TMPDIR/linear_data.json"
  fi
fi

# ── 3. For each PR, determine review status and who is responsible ───────────
echo "Checking review status for each PR..." >&2

echo '[]' > "$TMPDIR/pr_details.json"

PR_INDICES=$(jq -r 'to_entries | .[].key' "$TMPDIR/prs.json")

for IDX in $PR_INDICES; do
  PR_NUM=$(jq -r ".[$IDX].number" "$TMPDIR/prs.json")
  TITLE=$(jq -r ".[$IDX].title | if length > 60 then .[:57] + \"...\" else . end" "$TMPDIR/prs.json")
  AUTHOR=$(jq -r ".[$IDX].author.login" "$TMPDIR/prs.json")
  URL=$(jq -r ".[$IDX].url" "$TMPDIR/prs.json")
  CREATED=$(jq -r ".[$IDX].createdAt | split(\"T\")[0]" "$TMPDIR/prs.json")

  echo "  PR #${PR_NUM}..." >&2

  # Requested reviewers (explicit assignments)
  REQUESTED_JSON=$(jq -c "[ .[$IDX].reviewRequests[]? | (.login // .name // .slug) ]" "$TMPDIR/prs.json")

  # Fetch full reviews from API
  gh api "repos/$REPO/pulls/$PR_NUM/reviews" 2>/dev/null > "$TMPDIR/pr_reviews.json" || echo '[]' > "$TMPDIR/pr_reviews.json"

  # Latest review state per human reviewer
  REVIEWER_STATES=$(jq '[
    group_by(.user.login)[] |
    select(.[0].user.login != null) |
    {
      login: .[0].user.login,
      latest_state: (sort_by(.submitted_at) | last | .state),
      latest_at: (sort_by(.submitted_at) | last | .submitted_at)
    }
  ]' "$TMPDIR/pr_reviews.json" \
    | jq '[.[] | select(
        .login != "coderabbitai" and .login != "coderabbitai[bot]" and
        .login != "copilot-pull-request-reviewer" and .login != "copilot-pull-request-reviewer[bot]" and
        .login != "Copilot" and .login != "github-actions" and .login != "github-actions[bot]" and
        .login != "snyk-bot" and .login != "socket-security[bot]" and
        .login != "vercel[bot]" and .login != "dependabot[bot]"
      ) | select(.login != "'"$AUTHOR"'")]')

  # Latest commit timestamp
  LATEST_COMMIT_AT=$(gh api "repos/$REPO/pulls/$PR_NUM/commits" 2>/dev/null \
    | jq -r '[.[]?.commit.committer.date // ""] | sort | last // ""' || echo "")

  # Open conversations
  OPEN_CONVERSATIONS=$(gh api graphql -f query="
    query {
      repository(owner: \"$(echo $REPO | cut -d/ -f1)\", name: \"$(echo $REPO | cut -d/ -f2)\") {
        pullRequest(number: $PR_NUM) {
          reviewThreads(first: 100) {
            nodes { isResolved }
          }
        }
      }
    }
  " 2>/dev/null | jq '[.data.repository.pullRequest.reviewThreads.nodes[]? | select(.isResolved == false)] | length' || echo "0")

  # Is approved by a human?
  IS_APPROVED=$(echo "$REVIEWER_STATES" | jq '[.[] | select(.latest_state == "APPROVED")] | length > 0')

  # Changes requested?
  CHANGES_REQUESTED=$(echo "$REVIEWER_STATES" | jq '[.[] | select(.latest_state == "CHANGES_REQUESTED")] | length > 0')

  # Linear priority for this PR
  LIN_IDS=$(jq -r "
    [
      ((.[$IDX].headRefName // \"\") | ascii_upcase | [scan(\"LLE-[0-9]+\")] | .[]),
      ((.[$IDX].title // \"\")       | ascii_upcase | [scan(\"LLE-[0-9]+\")] | .[]),
      ((.[$IDX].body // \"\")        | ascii_upcase | [scan(\"LLE-[0-9]+\")] | .[])
    ] | unique | join(\", \")
  " "$TMPDIR/prs.json")

  PRIORITY=5
  PRIORITY_LABEL="No priority"
  if [[ -n "$LIN_IDS" && "$LIN_IDS" != "null" ]]; then
    for LID in $(echo "$LIN_IDS" | tr ',' '\n' | sed 's/^ *//;s/ *$//'); do
      P=$(jq -r --arg id "$LID" '.[$id].priority // 5' "$TMPDIR/linear_data.json")
      PL=$(jq -r --arg id "$LID" '.[$id].priorityLabel // "No priority"' "$TMPDIR/linear_data.json")
      if [[ "$P" -lt "$PRIORITY" ]]; then
        PRIORITY=$P
        PRIORITY_LABEL=$PL
      fi
    done
  fi

  # Determine action status
  if [[ "$IS_APPROVED" == "true" && "$CHANGES_REQUESTED" != "true" ]]; then
    ACTION_STATUS="merge_ready"
  elif [[ "${OPEN_CONVERSATIONS:-0}" -gt 0 ]]; then
    ACTION_STATUS="waiting_author"
  elif [[ "$CHANGES_REQUESTED" == "true" ]]; then
    ACTION_STATUS="waiting_author"
  else
    ACTION_STATUS="waiting_reviewer"
  fi

  # Build the list of people who need to act on this PR
  # - If waiting_reviewer: the requested reviewers need to review
  # - If waiting_author: the author needs to act
  # - If merge_ready: the author needs to merge
  WAITING_ON='[]'
  if [[ "$ACTION_STATUS" == "waiting_reviewer" ]]; then
    # People explicitly requested
    WAITING_ON=$(echo "$REQUESTED_JSON" | jq -c '.')

    # If no one requested, but there are reviewers who commented, they might need re-review
    if [[ $(echo "$WAITING_ON" | jq 'length') -eq 0 ]]; then
      # Check if new commits since last review
      LATEST_REVIEW_AT=$(echo "$REVIEWER_STATES" | jq -r '[.[].latest_at // ""] | sort | last // ""')
      if [[ -n "$LATEST_REVIEW_AT" && -n "$LATEST_COMMIT_AT" && "$LATEST_COMMIT_AT" > "$LATEST_REVIEW_AT" ]]; then
        # Reviewers who already reviewed need to re-review
        WAITING_ON=$(echo "$REVIEWER_STATES" | jq -c '[.[].login]')
      fi
    fi
  fi

  # Append to results
  jq \
    --argjson number "$PR_NUM" \
    --arg title "$TITLE" \
    --arg author "$AUTHOR" \
    --arg url "$URL" \
    --arg created "$CREATED" \
    --arg action_status "$ACTION_STATUS" \
    --argjson open_conversations "${OPEN_CONVERSATIONS:-0}" \
    --argjson requested "$REQUESTED_JSON" \
    --argjson reviewer_states "$REVIEWER_STATES" \
    --argjson waiting_on "$WAITING_ON" \
    --arg latest_commit_at "$LATEST_COMMIT_AT" \
    --arg linear_ids "$LIN_IDS" \
    --argjson priority "$PRIORITY" \
    --arg priority_label "$PRIORITY_LABEL" \
    '. + [{
      number: $number,
      title: $title,
      author: $author,
      url: $url,
      created: $created,
      action_status: $action_status,
      open_conversations: $open_conversations,
      requested_reviewers: $requested,
      reviewer_states: $reviewer_states,
      waiting_on: $waiting_on,
      latest_commit_at: $latest_commit_at,
      linear_ids: $linear_ids,
      priority: $priority,
      priority_label: $priority_label
    }]' "$TMPDIR/pr_details.json" > "$TMPDIR/pr_details_tmp.json"
  mv "$TMPDIR/pr_details_tmp.json" "$TMPDIR/pr_details.json"
done

# ── 4. Group by reviewer ────────────────────────────────────────────────────
echo "Building team dashboard..." >&2

# Build a JSON object: { reviewer: login, prs_to_review: [...], prs_authored: [...] }
# for each team member
MEMBERS_JSON=$(printf '%s\n' "${MEMBERS[@]}" | jq -R -s 'split("\n") | map(select(. != ""))')

jq --argjson members "$MEMBERS_JSON" '
  . as $all_prs |
  [$members[] | . as $member | {
    reviewer: $member,
    prs_to_review: [
      $all_prs[] | select(
        (.action_status == "waiting_reviewer") and
        (
          (.requested_reviewers | map(ascii_downcase) | index($member | ascii_downcase)) or
          (.waiting_on | map(ascii_downcase) | index($member | ascii_downcase))
        )
      ) | {
        number, title, author, url, priority, priority_label, linear_ids,
        open_conversations,
        review_type: (
          if (.reviewer_states | map(.login | ascii_downcase) | index($member | ascii_downcase))
          then "re-review"
          else "fresh"
          end
        )
      }
    ] | sort_by(.priority, .number),
    prs_authored_needing_action: [
      $all_prs[] | select(
        (.author | ascii_downcase) == ($member | ascii_downcase) and
        .action_status == "waiting_author"
      ) | {
        number, title, url, priority, priority_label, open_conversations,
        changes_from: [.reviewer_states[] | select(.latest_state == "CHANGES_REQUESTED") | .login]
      }
    ] | sort_by(.priority, .number),
    prs_merge_ready: [
      $all_prs[] | select(
        (.author | ascii_downcase) == ($member | ascii_downcase) and
        .action_status == "merge_ready"
      ) | { number, title, url }
    ]
  }]
' "$TMPDIR/pr_details.json" > "$TMPDIR/team_dashboard.json"

# ── 5. Output ────────────────────────────────────────────────────────────────
if [[ "$OUTPUT_FORMAT" == "json" ]]; then
  jq '.' "$TMPDIR/team_dashboard.json"
  exit 0
fi

cat "$TMPDIR/team_dashboard.json"
