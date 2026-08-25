#!/usr/bin/env bash
#
# fetch-conversation.sh — Fetch existing PR review threads and issue comments,
# format as a compact markdown summary for sub-agent prompts.
#
# Usage:
#   fetch-conversation.sh --pr NUMBER [--repo OWNER/NAME]
#
# Output: markdown summary to stdout. Exits 0 on success even if conversation is empty.
#
# Dependencies: bash, gh, jq

set -euo pipefail

PR_NUMBER=""
REPO=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pr)   PR_NUMBER="$2"; shift 2 ;;
        --repo) REPO="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$PR_NUMBER" ]]; then
    echo "Error: --pr NUMBER is required" >&2
    exit 1
fi

if [[ -z "$REPO" ]]; then
    REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
    if [[ -z "$REPO" ]]; then
        echo "Error: --repo OWNER/NAME required when not in a git repo" >&2
        exit 1
    fi
fi

OWNER="${REPO%/*}"
NAME="${REPO#*/}"

# --- Fetch line-comment threads (with resolution state) via GraphQL ---

threads_json=$(gh api graphql -f query='
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first:50) {
            nodes {
              author { login }
              body
              createdAt
            }
          }
        }
      }
    }
  }
}' -f owner="$OWNER" -f repo="$NAME" -F number="$PR_NUMBER" 2>/dev/null || echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}')

# --- Fetch issue-level discussion via REST ---

issue_json=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate 2>/dev/null || echo '[]')

# --- Format output ---

echo "## Prior Discussion"
echo
echo "### Line-comment threads"

threads_md=$(echo "$threads_json" | jq -r '
  .data.repository.pullRequest.reviewThreads.nodes
  | map(select(.comments.nodes | length > 0))
  | .[]
  | (
      if .isResolved then "RESOLVED"
      elif .isOutdated then "OUTDATED"
      else "OPEN"
      end
    ) as $state
  | (.line // .originalLine // "") as $line
  | (
      .comments.nodes
      | map(
          ((.author.login // "deleted") + ": " + ((.body // "") | gsub("\\s+"; " ") | .[0:240]))
        )
      | join(" → ")
    ) as $msgs
  | "- **[\($state)]** `\(.path)`" + (if $line != "" then ":\($line)" else "" end) + " — \($msgs)"
')

if [[ -z "$threads_md" ]]; then
    echo "_No line-comment threads on this PR._"
else
    echo "$threads_md"
fi

echo
echo "### Issue-level discussion"

issue_md=$(echo "$issue_json" | jq -r '
  .[]
  | "- **\(.user.login // "deleted")** (\(.created_at[0:10])): \((.body // "") | gsub("\\s+"; " ") | .[0:400])"
')

if [[ -z "$issue_md" ]]; then
    echo "_No issue-level discussion on this PR._"
else
    echo "$issue_md"
fi
