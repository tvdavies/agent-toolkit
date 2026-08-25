#!/usr/bin/env bash
#
# pr-review-table.sh — List open PRs from the last N days, ordered by Linear priority.
#
# Shows: priority, PR, title, author, approver, action status, open conversations,
#        Linear issues, labels, and state.
#
# Action status logic:
#   - If approved → "Merge ready"
#   - If review comments exist but no new commits since last review → "Waiting for author"
#   - If changes pushed after last review → "Waiting for reviewer"
#   - If no reviewer assigned/commenting → "Needs reviewer"
#
# Dependencies: gh, jq, curl
# Config:       Reads LINEAR_API_KEY from env, or falls back to ~/.config/linear-cli/config.toml
#
# Usage:
#   ./scripts/pr-review-table.sh            # default: last 7 days
#   ./scripts/pr-review-table.sh --days 14  # last 14 days
#   ./scripts/pr-review-table.sh --json     # output raw JSON instead of table

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

# ── Temp dir (cleaned up on exit) ────────────────────────────────────────────
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# ── Resolve Linear API key ───────────────────────────────────────────────────
if [[ -z "${LINEAR_API_KEY:-}" ]]; then
  LINEAR_CONFIG="$HOME/.config/linear-cli/config.toml"
  if [[ -f "$LINEAR_CONFIG" ]]; then
    LINEAR_API_KEY=$(grep 'api_key' "$LINEAR_CONFIG" | head -1 | sed 's/.*= *"\(.*\)"/\1/')
  fi
fi

if [[ -z "${LINEAR_API_KEY:-}" ]]; then
  echo "Error: No LINEAR_API_KEY found. Set it in env or install linear-cli." >&2
  exit 1
fi

# ── 1. Fetch open PRs created in the last N days ────────────────────────────
CUTOFF=$(date -u -d "-${DAYS} days" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -v-${DAYS}d +%Y-%m-%dT%H:%M:%SZ) # GNU vs BSD date

echo "Fetching open PRs from the last ${DAYS} days…" >&2

gh pr list \
  --state open \
  --json number,title,author,createdAt,reviewRequests,reviews,url,headRefName,body,isDraft \
  --limit 100 > "$TMPDIR/all_prs.json"

# Filter to non-draft PRs within date range
cat > "$TMPDIR/filter.jq" << JQEOF
[.[] | select(.createdAt > "$CUTOFF" and .isDraft != true)]
JQEOF
jq -f "$TMPDIR/filter.jq" "$TMPDIR/all_prs.json" > "$TMPDIR/prs.json"

PR_COUNT=$(jq 'length' "$TMPDIR/prs.json")
echo "Found ${PR_COUNT} open PRs." >&2

if [[ "$PR_COUNT" -eq 0 ]]; then
  echo "No open PRs in the last ${DAYS} days."
  exit 0
fi

# ── 2. Extract Linear issue IDs ─────────────────────────────────────────────
LINEAR_IDS=$(jq -r '
  [.[] |
    ((.headRefName // "") | ascii_upcase | [scan("LLE-[0-9]+")] | .[]),
    ((.title // "")       | ascii_upcase | [scan("LLE-[0-9]+")] | .[]),
    ((.body // "")        | ascii_upcase | [scan("LLE-[0-9]+")] | .[])
  ] | unique | .[]
' "$TMPDIR/prs.json")

ISSUE_NUMBERS=$(echo "$LINEAR_IDS" | sed 's/LLE-//' | sort -un | tr '\n' ',' | sed 's/,$//')

# ── 3. Fetch Linear issue priorities ────────────────────────────────────────
echo '{}' > "$TMPDIR/linear_data.json"

if [[ -n "$ISSUE_NUMBERS" ]]; then
  ISSUE_COUNT=$(echo "$ISSUE_NUMBERS" | tr ',' '\n' | wc -l | tr -d ' ')
  echo "Fetching priorities for ${ISSUE_COUNT} Linear issues…" >&2

  GRAPHQL_QUERY=$(jq -n --arg nums "$ISSUE_NUMBERS" '{
    query: ("query { issues(filter: { team: { key: { eq: \"LLE\" } }, number: { in: [" + $nums + "] } }, first: 50) { nodes { identifier title priority priorityLabel state { name } labels { nodes { name } } } } }")
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
        state: .state.name,
        labels: [.labels.nodes[]?.name]
      }
    }] | from_entries
  ' "$TMPDIR/linear_response.json" > "$TMPDIR/linear_data.json"
fi

# ── 4. Build results: determine reviewer + action status for each PR ────────
echo "Checking review status…" >&2

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# jq filter to exclude bots from a list of logins
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

# Initialise results array
echo '[]' > "$TMPDIR/results.json"

PR_INDICES=$(jq -r 'to_entries | .[].key' "$TMPDIR/prs.json")

for IDX in $PR_INDICES; do
  PR_NUM=$(jq -r ".[$IDX].number" "$TMPDIR/prs.json")
  TITLE=$(jq -r ".[$IDX].title | if length > 70 then .[:67] + \"…\" else . end" "$TMPDIR/prs.json")
  AUTHOR=$(jq -r ".[$IDX].author.login" "$TMPDIR/prs.json")
  URL=$(jq -r ".[$IDX].url" "$TMPDIR/prs.json")
  CREATED=$(jq -r ".[$IDX].createdAt | split(\"T\")[0]" "$TMPDIR/prs.json")

  echo "  PR #${PR_NUM}…" >&2

  # Requested reviewers
  REQUESTED=$(jq -r "[ .[$IDX].reviewRequests[]? | (.login // .name // .slug) ] | join(\", \")" "$TMPDIR/prs.json")

  # Human reviewers from inline review data (filtering bots)
  HUMAN_REVIEWERS=$(jq -r "[ .[$IDX].reviews[]? | .author.login ] | unique" "$TMPDIR/prs.json" \
    | jq -r -f "$TMPDIR/exclude_bots.jq" \
    | jq -r 'join(", ")')

  # If no requested reviewers AND no human reviewers in the cached data,
  # hit the API for reviews + inline comments to find implicit reviewers
  if [[ -z "$REQUESTED" && -z "$HUMAN_REVIEWERS" ]]; then
    API_REVIEWERS=$(gh api "repos/$REPO/pulls/$PR_NUM/reviews" 2>/dev/null \
      | jq '[.[]? | .user.login] | unique' \
      | jq -r -f "$TMPDIR/exclude_bots.jq" \
      | jq -r '.[]' || true)
    API_COMMENTERS=$(gh api "repos/$REPO/pulls/$PR_NUM/comments" 2>/dev/null \
      | jq '[.[]? | .user.login] | unique' \
      | jq -r -f "$TMPDIR/exclude_bots.jq" \
      | jq -r '.[]' || true)
    HUMAN_REVIEWERS=$(printf '%s\n%s' "$API_REVIEWERS" "$API_COMMENTERS" \
      | sort -u | { grep -v '^$' || true; } | tr '\n' ',' | sed 's/,$//' | sed 's/,/, /g')
  fi

  # Remove self-reviews (author commenting on own PR doesn't count)
  if [[ -n "$HUMAN_REVIEWERS" ]]; then
    HUMAN_REVIEWERS=$(echo "$HUMAN_REVIEWERS" \
      | tr ',' '\n' | sed 's/^ *//;s/ *$//' \
      | { grep -v "^${AUTHOR}$" || true; } \
      | tr '\n' ',' | sed 's/,$//' | sed 's/,/, /g')
  fi

  # Determine who needs to approve
  if [[ -n "$REQUESTED" ]]; then
    APPROVER="$REQUESTED"
    APPROVER_SOURCE="assigned"
  elif [[ -n "$HUMAN_REVIEWERS" ]]; then
    APPROVER="$HUMAN_REVIEWERS"
    APPROVER_SOURCE="commenting"
  else
    APPROVER="—"
    APPROVER_SOURCE="none"
  fi

  # ── Fetch review details + open conversations + action status ──────────
  # Get full reviews from API (state: APPROVED, CHANGES_REQUESTED, COMMENTED)
  gh api "repos/$REPO/pulls/$PR_NUM/reviews" 2>/dev/null > "$TMPDIR/pr_reviews.json" || echo '[]' > "$TMPDIR/pr_reviews.json"

  # Check if approved
  IS_APPROVED=$(jq '[.[]? | select(.state == "APPROVED") | .user.login] | unique
    | map(select(
        . != "coderabbitai" and . != "coderabbitai[bot]" and
        . != "copilot-pull-request-reviewer" and . != "copilot-pull-request-reviewer[bot]" and
        . != "Copilot"
      )) | length > 0' "$TMPDIR/pr_reviews.json")

  # Check if changes requested
  CHANGES_REQUESTED=$(jq '[.[]? | select(.state == "CHANGES_REQUESTED") | .user.login] | unique
    | map(select(
        . != "coderabbitai" and . != "coderabbitai[bot]" and
        . != "copilot-pull-request-reviewer" and . != "copilot-pull-request-reviewer[bot]" and
        . != "Copilot"
      )) | length > 0' "$TMPDIR/pr_reviews.json")

  # Latest human review timestamp
  LATEST_REVIEW_AT=$(jq -r '[.[]? | select(
      .user.login != "coderabbitai" and .user.login != "coderabbitai[bot]" and
      .user.login != "copilot-pull-request-reviewer" and .user.login != "copilot-pull-request-reviewer[bot]" and
      .user.login != "Copilot"
    ) | .submitted_at // ""] | sort | last // ""' "$TMPDIR/pr_reviews.json")

  # Latest commit timestamp
  LATEST_COMMIT_AT=$(gh api "repos/$REPO/pulls/$PR_NUM/commits" 2>/dev/null \
    | jq -r '[.[]?.commit.committer.date // ""] | sort | last // ""' || echo "")

  # Open (unresolved) review threads count
  # The GraphQL API gives us reviewThreads with isResolved
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

  # Determine action status
  if [[ "$IS_APPROVED" == "true" && "$CHANGES_REQUESTED" != "true" ]]; then
    ACTION_STATUS="✅ Merge ready"
  elif [[ "${OPEN_CONVERSATIONS:-0}" -gt 0 ]]; then
    # Open review conversations → author needs to address them first
    ACTION_STATUS="✏️ Waiting for author"
  elif [[ "$CHANGES_REQUESTED" == "true" ]]; then
    ACTION_STATUS="✏️ Waiting for author"
  elif [[ "$APPROVER_SOURCE" == "none" ]]; then
    ACTION_STATUS="👀 Needs reviewer"
  elif [[ -n "$LATEST_REVIEW_AT" && -n "$LATEST_COMMIT_AT" && "$LATEST_COMMIT_AT" > "$LATEST_REVIEW_AT" ]]; then
    ACTION_STATUS="⏳ Waiting for reviewer"
  elif [[ -n "$LATEST_REVIEW_AT" ]]; then
    ACTION_STATUS="✏️ Waiting for author"
  else
    ACTION_STATUS="⏳ Waiting for reviewer"
  fi

  # Linear issue IDs for this PR
  LIN_IDS=$(jq -r "
    [
      ((.[$IDX].headRefName // \"\") | ascii_upcase | [scan(\"LLE-[0-9]+\")] | .[]),
      ((.[$IDX].title // \"\")       | ascii_upcase | [scan(\"LLE-[0-9]+\")] | .[]),
      ((.[$IDX].body // \"\")        | ascii_upcase | [scan(\"LLE-[0-9]+\")] | .[])
    ] | unique | join(\", \")
  " "$TMPDIR/prs.json")

  # Look up priority from Linear data (take highest = lowest number)
  PRIORITY=5
  PRIORITY_LABEL="No priority"
  LINEAR_STATE=""
  LINEAR_LABELS=""

  if [[ -n "$LIN_IDS" && "$LIN_IDS" != "null" ]]; then
    for LID in $(echo "$LIN_IDS" | tr ',' '\n' | sed 's/^ *//;s/ *$//'); do
      P=$(jq -r --arg id "$LID" '.[$id].priority // 5' "$TMPDIR/linear_data.json")
      PL=$(jq -r --arg id "$LID" '.[$id].priorityLabel // "No priority"' "$TMPDIR/linear_data.json")
      ST=$(jq -r --arg id "$LID" '.[$id].state // ""' "$TMPDIR/linear_data.json")
      LB=$(jq -r --arg id "$LID" '.[$id].labels // [] | join(", ")' "$TMPDIR/linear_data.json")
      if [[ "$P" -lt "$PRIORITY" ]]; then
        PRIORITY=$P
        PRIORITY_LABEL=$PL
        LINEAR_STATE=$ST
        LINEAR_LABELS=$LB
      fi
    done
  fi

  # Append to results
  jq \
    --argjson number "$PR_NUM" \
    --arg title "$TITLE" \
    --arg author "$AUTHOR" \
    --arg url "$URL" \
    --arg created "$CREATED" \
    --arg approver "$APPROVER" \
    --arg approver_source "$APPROVER_SOURCE" \
    --arg action_status "$ACTION_STATUS" \
    --argjson open_conversations "${OPEN_CONVERSATIONS:-0}" \
    --arg linear_ids "$LIN_IDS" \
    --argjson priority "$PRIORITY" \
    --arg priority_label "$PRIORITY_LABEL" \
    --arg linear_state "$LINEAR_STATE" \
    --arg linear_labels "$LINEAR_LABELS" \
    '. + [{
      number: $number,
      title: $title,
      author: $author,
      url: $url,
      created: $created,
      approver: $approver,
      approver_source: $approver_source,
      action_status: $action_status,
      open_conversations: $open_conversations,
      linear_ids: $linear_ids,
      priority: $priority,
      priority_label: $priority_label,
      linear_state: $linear_state,
      linear_labels: $linear_labels
    }]' "$TMPDIR/results.json" > "$TMPDIR/results_tmp.json"
  mv "$TMPDIR/results_tmp.json" "$TMPDIR/results.json"
done

# ── 5. Sort by priority (1=Urgent first, 5=None last), then by PR number ────
jq 'sort_by(.priority, .number)' "$TMPDIR/results.json" > "$TMPDIR/sorted.json"

# ── 6. Output ────────────────────────────────────────────────────────────────
if [[ "$OUTPUT_FORMAT" == "json" ]]; then
  jq '.' "$TMPDIR/sorted.json"
  exit 0
fi

# Priority emoji mapping (for markdown/slack)
priority_icon() {
  case "$1" in
    1) echo "🔴" ;;
    2) echo "🟠" ;;
    3) echo "🟡" ;;
    4) echo "🔵" ;;
    *) echo "⚪" ;;
  esac
}

# Priority short label for fixed-width table
priority_short() {
  case "$1" in
    1) echo "URG" ;;
    2) echo "HI " ;;
    3) echo "MED" ;;
    4) echo "LOW" ;;
    *) echo "—  " ;;
  esac
}

if [[ "$OUTPUT_FORMAT" == "slack" ]]; then
  # ── Slack output: code-block table ──────────────────────────────────────
  # Uses plain ASCII inside the code block to avoid emoji alignment issues.

  # Build table rows into temp file
  : > "$TMPDIR/table_rows.txt"

  jq -c '.[]' "$TMPDIR/sorted.json" | while IFS= read -r row; do
    PR_NUM=$(echo "$row" | jq -r '.number')
    PRI=$(echo "$row" | jq -r '.priority')
    TITLE=$(echo "$row" | jq -r '.title | if length > 36 then .[:33] + "..." else . end')
    AUTHOR=$(echo "$row" | jq -r '.author | if length > 14 then .[:13] + "." else . end')
    APPROVER=$(echo "$row" | jq -r '.approver | if . == "\u2014" then "-" else (if length > 14 then .[:13] + "." else . end) end')
    ACTION=$(echo "$row" | jq -r '.action_status')
    OPEN_CONVOS=$(echo "$row" | jq -r '.open_conversations')
    LIN=$(echo "$row" | jq -r '.linear_ids | split(", ") | first // "-"')

    PRI_SHORT=$(priority_short "$PRI")

    # Plain text status labels (no emoji inside code block)
    case "$ACTION" in
      *"Merge ready"*)        STATUS="MERGE"     ;;
      *"Waiting for author"*) STATUS=">> AUTHOR"  ;;
      *"Waiting for reviewer"*) STATUS="REVIEW"     ;;
      *"Needs reviewer"*)     STATUS="UNASSIGNED"  ;;
      *)                      STATUS="$ACTION"    ;;
    esac

    CONVOS="-"
    if [[ "$OPEN_CONVOS" -gt 0 ]]; then
      CONVOS="$OPEN_CONVOS"
    fi

    printf "%-3s  #%-4s  %-8s  %-36s  %-14s  %-14s  %-10s  %s\n" \
      "$PRI_SHORT" "$PR_NUM" "$LIN" "$TITLE" "$AUTHOR" "$APPROVER" "$STATUS" "$CONVOS" \
      >> "$TMPDIR/table_rows.txt"
  done

  # Compose final slack message
  TOTAL=$(jq 'length' "$TMPDIR/sorted.json")
  WAITING_AUTHOR=$(jq '[.[] | select(.action_status | test("author"))] | length' "$TMPDIR/sorted.json")
  WAITING_REVIEWER=$(jq '[.[] | select(.action_status | test("reviewer"))] | length' "$TMPDIR/sorted.json")
  NEEDS_REVIEWER=$(jq '[.[] | select(.action_status | test("Needs"))] | length' "$TMPDIR/sorted.json")
  MERGE_READY=$(jq '[.[] | select(.action_status | test("Merge"))] | length' "$TMPDIR/sorted.json")

  {
    echo ":clipboard: *Open PR Review Board* — last ${DAYS} days (${TOTAL} PRs)"
    echo ""
    echo '```'
    printf "%-3s  %-5s  %-8s  %-36s  %-14s  %-14s  %-10s  %s\n" \
      "Pri" "PR" "Ticket" "Title" "Author" "Approver" "Status" "Threads"
    printf "%-3s  %-5s  %-8s  %-36s  %-14s  %-14s  %-10s  %s\n" \
      "---" "-----" "--------" "------------------------------------" "--------------" "--------------" "----------" "-------"
    cat "$TMPDIR/table_rows.txt"
    echo '```'
    echo ""
    echo "✅ Merge: ${MERGE_READY} · ✏️ Author: ${WAITING_AUTHOR} · ⏳ Reviewer: ${WAITING_REVIEWER} · 👀 Unassigned: ${NEEDS_REVIEWER}"
  } > "$TMPDIR/slack_output.txt"

  cat "$TMPDIR/slack_output.txt"
  exit 0
fi

# ── Markdown table (default) ─────────────────────────────────────────────────
echo ""
echo "| Pri | PR | Title | Author | Approver | Status | 💬 | Linear | Labels | State |"
echo "|-----|-----|-------|--------|----------|--------|----|--------|--------|-------|"

jq -c '.[]' "$TMPDIR/sorted.json" | while IFS= read -r row; do
  PR_NUM=$(echo "$row" | jq -r '.number')
  PRI=$(echo "$row" | jq -r '.priority')
  PRI_LABEL=$(echo "$row" | jq -r '.priority_label')
  TITLE=$(echo "$row" | jq -r '.title')
  AUTHOR=$(echo "$row" | jq -r '.author')
  APPROVER=$(echo "$row" | jq -r '.approver')
  APPROVER_SRC=$(echo "$row" | jq -r '.approver_source')
  ACTION=$(echo "$row" | jq -r '.action_status')
  OPEN_CONVOS=$(echo "$row" | jq -r '.open_conversations')
  LIN=$(echo "$row" | jq -r '.linear_ids')
  LABELS=$(echo "$row" | jq -r '.linear_labels')
  STATE=$(echo "$row" | jq -r '.linear_state')
  URL=$(echo "$row" | jq -r '.url')

  ICON=$(priority_icon "$PRI")

  if [[ "$APPROVER_SRC" == "commenting" ]]; then
    APPROVER_FMT="${APPROVER} *(implicit)*"
  else
    APPROVER_FMT="${APPROVER}"
  fi

  if [[ "$OPEN_CONVOS" -gt 0 ]]; then
    CONVO_FMT="${OPEN_CONVOS}"
  else
    CONVO_FMT="—"
  fi

  echo "| ${ICON} ${PRI_LABEL} | [#${PR_NUM}](${URL}) | ${TITLE} | ${AUTHOR} | ${APPROVER_FMT} | ${ACTION} | ${CONVO_FMT} | ${LIN} | ${LABELS} | ${STATE} |"
done

echo ""
echo "_Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) · PRs from last ${DAYS} days_"
