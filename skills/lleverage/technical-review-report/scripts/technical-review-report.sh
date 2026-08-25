#!/usr/bin/env bash
set -euo pipefail

TEAM="LLE"
STATE="Technical Review"
FORMAT="markdown"
REPO=""
ALL_TECH_REVIEW=false
LIMIT=200

usage() {
  cat <<'EOF'
Usage: technical-review-report.sh [options]

Options:
  --team TEAM              Linear team key/name (default: LLE)
  --state STATE            Linear state (default: Technical Review)
  --repo OWNER/REPO        GitHub repo (default: current repo, then lleverage-ai/lleverage)
  --format markdown|json   Output format (default: markdown)
  --all-tech-review        Include all issues in the state, not just current cycle
  --limit N                Max Linear issues when using --all-tech-review (default: 200)
  -h, --help               Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --team) TEAM="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --format) FORMAT="$2"; shift 2 ;;
    --all-tech-review) ALL_TECH_REVIEW=true; shift ;;
    --limit) LIMIT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if ! command -v linear-cli >/dev/null; then
  echo "linear-cli is required" >&2
  exit 1
fi
if ! command -v gh >/dev/null; then
  echo "gh is required" >&2
  exit 1
fi
if ! command -v jq >/dev/null; then
  echo "jq is required" >&2
  exit 1
fi

if [[ "$FORMAT" != "markdown" && "$FORMAT" != "json" ]]; then
  echo "--format must be markdown or json" >&2
  exit 1
fi

if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
fi
if [[ -z "$REPO" ]]; then
  REPO="lleverage-ai/lleverage"
fi

json_escape() {
  jq -Rn --arg v "$1" '$v'
}

issue_ids_regex='LLE-[0-9]+'

cycle_json='null'
if [[ "$ALL_TECH_REVIEW" == false ]]; then
  cycle_json=$(linear-cli cycles current -t "$TEAM" --output json --compact --no-pager --quiet)
  issues=$(echo "$cycle_json" | jq --arg state "$STATE" '[.activeCycle.issues.nodes[] | select(.state.name == $state)]')
else
  issues=$(linear-cli issues list -t "$TEAM" -s "$STATE" --limit "$LIMIT" --output json --compact --no-pager --quiet)
fi

count=$(echo "$issues" | jq 'length')

if [[ "$count" -eq 0 ]]; then
  if [[ "$FORMAT" == "json" ]]; then
    jq -n --arg team "$TEAM" --arg state "$STATE" --arg repo "$REPO" '{team:$team,state:$state,repo:$repo,items:[]}'
  else
    echo "# Technical Review Report"
    echo
    echo "No $TEAM issues found in $STATE."
  fi
  exit 0
fi

items_file=$(mktemp)
trap 'rm -f "$items_file"' EXIT
: > "$items_file"

echo "$issues" | jq -c '.[]' | while read -r issue; do
  identifier=$(echo "$issue" | jq -r '.identifier')
  title=$(echo "$issue" | jq -r '.title')

  details=$(linear-cli issues get "$identifier" --output json --compact --no-pager --quiet 2>/dev/null || echo '{}')
  assignee=$(echo "$details" | jq -r '.assignee.name // .assignee.email // "Unassigned"')
  issue_url=$(echo "$details" | jq -r '.url // ""')
  updated_at=$(echo "$details" | jq -r '.updatedAt // ""')
  project=$(echo "$details" | jq -r '.project.name // ""')

  prs=$(gh search prs "$identifier" --repo "$REPO" --state open --json number,title,url,author,repository,createdAt --jq '.' 2>/dev/null || echo '[]')
  pr_count=$(echo "$prs" | jq 'length')

  if [[ "$pr_count" -eq 0 ]]; then
    jq -n \
      --arg identifier "$identifier" \
      --arg title "$title" \
      --arg url "$issue_url" \
      --arg assignee "$assignee" \
      --arg project "$project" \
      --arg updatedAt "$updated_at" \
      '{issue:{identifier:$identifier,title:$title,url:$url,assignee:$assignee,project:$project,updatedAt:$updatedAt}, prs:[], status:"No PR found", actionOwner:$assignee, actionType:"author", action:"Open or link a PR", severity:1}' >> "$items_file"
    continue
  fi

  analyses_file=$(mktemp)
  : > "$analyses_file"
  echo "$prs" | jq -c '.[]' | while read -r pr_search; do
    number=$(echo "$pr_search" | jq -r '.number')
    pr=$(gh pr view "$number" --repo "$REPO" --json number,title,url,author,isDraft,mergeStateStatus,reviewDecision,reviewRequests,reviews,commits,statusCheckRollup,headRefName,body,createdAt,updatedAt 2>/dev/null || echo '{}')

    pr_id=$(gh pr view "$number" --repo "$REPO" --json id --jq '.id' 2>/dev/null || true)
    unresolved_threads=0
    if [[ -n "$pr_id" && "$pr_id" != "null" ]]; then
      unresolved_threads=$(gh api graphql \
        -f query='query($id:ID!){node(id:$id){... on PullRequest{reviewThreads(first:100){nodes{isResolved}}}}}' \
        -f id="$pr_id" \
        --jq '[.data.node.reviewThreads.nodes[]? | select(.isResolved == false)] | length' 2>/dev/null || echo 0)
    fi

    analysis=$(echo "$pr" | jq --argjson unresolved "$unresolved_threads" --arg issue "$identifier" --arg assignee "$assignee" --arg regex "$issue_ids_regex" '
      def reviewer_names: [.reviewRequests[]? | .login // .name // empty];
      def last_reviews: ([.reviews[]?] | group_by(.author.login) | map(last));
      def changes_requested: [last_reviews[]? | select(.state == "CHANGES_REQUESTED") | .author.login];
      def approvals: [last_reviews[]? | select(.state == "APPROVED") | .author.login];
      def check_items: [.statusCheckRollup[]?];
      def failed_checks: [check_items[] | select((.conclusion // .state // "") | test("FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED")) | (.name // .context // "check")];
      def pending_checks: [check_items[] | select((.status // .state // "") | test("QUEUED|IN_PROGRESS|PENDING|EXPECTED")) | (.name // .context // "check")];
      def mentioned_ids: (((.title // "") + " " + (.body // "") + " " + (.headRefName // "")) | [match($regex; "g").string] | unique);
      def author: (.author.login // $assignee);
      def status:
        if .isDraft then "Draft PR"
        elif (.mergeStateStatus == "DIRTY") then "Merge conflicts"
        elif (changes_requested | length) > 0 then "Changes requested"
        elif $unresolved > 0 then "Unresolved review threads"
        elif (failed_checks | length) > 0 then "Checks failing"
        elif (pending_checks | length) > 0 then "Checks pending"
        elif (reviewer_names | length) > 0 then "Waiting for review"
        elif .reviewDecision == "APPROVED" then "Approved, not merged"
        elif .reviewDecision == "REVIEW_REQUIRED" then "Review required"
        else "Unclear"
        end;
      def action_type:
        if .isDraft or (.mergeStateStatus == "DIRTY") or ((changes_requested | length) > 0) or ($unresolved > 0) or ((failed_checks | length) > 0) or ((pending_checks | length) > 0) then "author"
        elif (reviewer_names | length) > 0 or .reviewDecision == "REVIEW_REQUIRED" then "reviewer"
        elif .reviewDecision == "APPROVED" then "author"
        else "unclear"
        end;
      def action_owner:
        if action_type == "reviewer" then ((reviewer_names | join(", ")) // "Reviewer")
        elif action_type == "author" then author
        else "Unclear"
        end;
      def action:
        if .isDraft then "Mark ready for review when ready"
        elif (.mergeStateStatus == "DIRTY") then "Resolve merge conflicts"
        elif (changes_requested | length) > 0 then "Address changes requested by " + (changes_requested | join(", "))
        elif $unresolved > 0 then "Resolve review threads"
        elif (failed_checks | length) > 0 then "Fix failing checks: " + (failed_checks | join(", "))
        elif (pending_checks | length) > 0 then "Wait for or fix pending checks: " + (pending_checks | join(", "))
        elif (reviewer_names | length) > 0 then "Review requested"
        elif .reviewDecision == "APPROVED" then "Merge or move ticket forward"
        elif .reviewDecision == "REVIEW_REQUIRED" then "Request/complete review"
        else "Inspect PR"
        end;
      {
        pr: {
          number, title, url, author: author, isDraft,
          mergeStateStatus, reviewDecision,
          reviewRequests: reviewer_names,
          changesRequestedBy: changes_requested,
          approvedBy: approvals,
          unresolvedThreads: $unresolved,
          failedChecks: failed_checks,
          pendingChecks: pending_checks,
          relatedIssueIds: mentioned_ids,
          createdAt, updatedAt,
          headRefName
        },
        status: status,
        actionType: action_type,
        actionOwner: action_owner,
        action: action,
        severity: (if action_type == "author" then 1 elif action_type == "reviewer" then 2 else 3 end)
      }')

    echo "$analysis" >> "$analyses_file"
  done

  analyses=$(jq -s '.' "$analyses_file")
  rm -f "$analyses_file"

  selected=$(echo "$analyses" | jq 'sort_by(.severity) | .[0]')
  jq -n \
    --arg identifier "$identifier" \
    --arg title "$title" \
    --arg url "$issue_url" \
    --arg assignee "$assignee" \
    --arg project "$project" \
    --arg updatedAt "$updated_at" \
    --argjson prs "$(echo "$analyses" | jq -c '[.[].pr]')" \
    --arg status "$(echo "$selected" | jq -r '.status')" \
    --arg actionType "$(echo "$selected" | jq -r '.actionType')" \
    --arg actionOwner "$(echo "$selected" | jq -r '.actionOwner')" \
    --arg action "$(echo "$selected" | jq -r '.action')" \
    --argjson severity "$(echo "$selected" | jq -r '.severity')" \
    '{issue:{identifier:$identifier,title:$title,url:$url,assignee:$assignee,project:$project,updatedAt:$updatedAt}, prs:$prs, status:$status, actionType:$actionType, actionOwner:$actionOwner, action:$action, severity:$severity}' >> "$items_file"
done

items=$(jq -s 'sort_by(.severity, .issue.identifier)' "$items_file")

scope="current_cycle"
cycle_number=""
cycle_starts=""
cycle_ends=""
if [[ "$ALL_TECH_REVIEW" == true ]]; then
  scope="all_technical_review"
else
  cycle_number=$(echo "$cycle_json" | jq -r '.activeCycle.number // ""')
  cycle_starts=$(echo "$cycle_json" | jq -r '.activeCycle.startsAt // ""')
  cycle_ends=$(echo "$cycle_json" | jq -r '.activeCycle.endsAt // ""')
fi

report=$(jq -n \
  --arg team "$TEAM" \
  --arg state "$STATE" \
  --arg repo "$REPO" \
  --arg scope "$scope" \
  --arg cycleNumber "$cycle_number" \
  --arg cycleStartsAt "$cycle_starts" \
  --arg cycleEndsAt "$cycle_ends" \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson items "$items" \
  '{team:$team,state:$state,repo:$repo,scope:$scope,cycle:{number:$cycleNumber,startsAt:$cycleStartsAt,endsAt:$cycleEndsAt},generatedAt:$generatedAt,summary:{total:($items|length),authorAction:($items|map(select(.actionType=="author"))|length),reviewerAction:($items|map(select(.actionType=="reviewer"))|length),unclear:($items|map(select(.actionType=="unclear"))|length),noPr:($items|map(select(.prs|length==0))|length)},items:$items}')

if [[ "$FORMAT" == "json" ]]; then
  echo "$report"
  exit 0
fi

echo "$report" | jq -r '
  def link($text; $url): if ($url // "") == "" then $text else "[" + $text + "](" + $url + ")" end;
  def pr_links: if (.prs|length) == 0 then "—" else (.prs | map(link("#" + (.number|tostring); .url)) | join(", ")) end;
  def related($id): ([.prs[]?.relatedIssueIds[]?] | unique | map(select(. != $id)) | if length == 0 then "" else " related: " + join(", ") end);
  "# Technical Review Report",
  "",
  "Team: " + .team + "  ",
  "State: " + .state + "  ",
  "Repo: " + .repo + "  ",
  (if .scope == "current_cycle" then "Cycle: " + (.cycle.number|tostring) + " (" + .cycle.startsAt + " → " + .cycle.endsAt + ")  " else "Scope: all technical review  " end),
  "Generated: " + .generatedAt,
  "",
  "## Summary",
  "",
  "| Total | Needs author | Needs reviewer | Unclear | No PR |",
  "|---:|---:|---:|---:|---:|",
  "| " + (.summary.total|tostring) + " | " + (.summary.authorAction|tostring) + " | " + (.summary.reviewerAction|tostring) + " | " + (.summary.unclear|tostring) + " | " + (.summary.noPr|tostring) + " |",
  "",
  "## Items",
  "",
  "| Issue | Assignee | PR | Status | Who needs to act | Next action | Notes |",
  "|---|---|---|---|---|---|---|",
  (.items[] | "| " + link(.issue.identifier; .issue.url) + " — " + (.issue.title | gsub("\\|"; "\\\\|")) + " | " + .issue.assignee + " | " + pr_links + " | " + .status + " | " + .actionOwner + " | " + (.action | gsub("\\|"; "\\\\|")) + " | " + (if (.prs|length)==0 then "" else ((.prs[0].reviewDecision // "") + (if .prs[0].unresolvedThreads > 0 then "; " + (.prs[0].unresolvedThreads|tostring) + " unresolved" else "" end) + related(.issue.identifier)) end) + " |")
'
