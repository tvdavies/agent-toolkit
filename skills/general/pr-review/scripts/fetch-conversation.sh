#!/usr/bin/env bash
#
# fetch-conversation.sh — Fetch existing PR review threads, review verdicts and
# issue comments, format as a compact markdown summary for sub-agent prompts.
#
# Retrieval is bounded and newest-first: the latest 100 line-comment threads,
# the latest 30 reviews (verdict bodies included), and the latest 50 issue
# comments. Truncation is reported in the output rather than silently dropped.
# Line-comment threads carry the id of the review that opened them, so a
# specific round's inline findings can be matched to its verdict entry.
#
# Exits 0 on success even when the conversation is empty; exits non-zero when
# retrieval itself fails, so a missing history is never mistaken for an empty
# one.
#
# Usage:
#   fetch-conversation.sh --pr NUMBER [--repo OWNER/NAME]
#
# Output: markdown summary to stdout.
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

# --- Fetch threads, reviews and issue comments in one bounded GraphQL query ---
#
# `reviews(last:)` and `comments(last:)` give a newest-first window in a single
# request, so a PR with a very large discussion history cannot make this fetch
# unbounded. Review bodies are included because verdict-bearing rounds
# (approvals, request-changes) live in review bodies, not issue comments.

if ! conversation_json=$(gh api graphql -f query='
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(last:100) {
        totalCount
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
              pullRequestReview { databaseId }
            }
          }
        }
      }
      reviews(last:30) {
        totalCount
        nodes {
          databaseId
          author { login }
          state
          body
          createdAt
        }
      }
      comments(last:50) {
        totalCount
        nodes {
          author { login }
          body
          createdAt
        }
      }
    }
  }
}' -f owner="$OWNER" -f repo="$NAME" -F number="$PR_NUMBER" 2>&1); then
    # Do not degrade a retrieval failure into an empty history: the caller
    # must be able to tell "no prior review" apart from "could not fetch".
    echo "Error: failed to retrieve PR conversation for #$PR_NUMBER:" >&2
    echo "$conversation_json" >&2
    exit 1
fi

threads_json=$conversation_json

# --- Format output ---

echo "## Prior Discussion"
echo
echo "### Line-comment threads"

threads_truncation=$(echo "$conversation_json" | jq -r '
  .data.repository.pullRequest.reviewThreads
  | if .totalCount > (.nodes | length)
    then "_Showing the newest \(.nodes | length) of \(.totalCount) line-comment threads._"
    else empty end
')
[[ -n "$threads_truncation" ]] && echo "$threads_truncation"

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
  | (.comments.nodes[0].pullRequestReview.databaseId // "") as $review_id
  | (
      .comments.nodes
      | map(
          ((.author.login // "deleted") + ": " + ((.body // "") | gsub("\\s+"; " ") | .[0:240]))
        )
      | join(" → ")
    ) as $msgs
  | "- **[\($state)]** `\(.path)`" + (if $line != "" then ":\($line)" else "" end) + (if $review_id != "" then " (review \($review_id))" else "" end) + " — \($msgs)"
')

if [[ -z "$threads_md" ]]; then
    echo "_No line-comment threads on this PR._"
else
    echo "$threads_md"
fi

echo
echo "### Reviews (verdicts)"

reviews_truncation=$(echo "$conversation_json" | jq -r '
  .data.repository.pullRequest.reviews
  | if .totalCount > (.nodes | length)
    then "_Showing the newest \(.nodes | length) of \(.totalCount) reviews._"
    else empty end
')
[[ -n "$reviews_truncation" ]] && echo "$reviews_truncation"

reviews_md=$(echo "$conversation_json" | jq -r '
  .data.repository.pullRequest.reviews.nodes
  | map(select(.state != "PENDING"))
  | .[]
  | "- **[\(.state)]** review \(.databaseId) by \(.author.login // "deleted") (\(.createdAt[0:10])): \(if (.body // "") == "" then "(no body)" else ((.body) | gsub("\\s+"; " ") | .[0:400]) end)"
')

if [[ -z "$reviews_md" ]]; then
    echo "_No reviews on this PR._"
else
    echo "$reviews_md"
fi

echo
echo "### Issue-level discussion"

comments_truncation=$(echo "$conversation_json" | jq -r '
  .data.repository.pullRequest.comments
  | if .totalCount > (.nodes | length)
    then "_Showing the newest \(.nodes | length) of \(.totalCount) issue comments._"
    else empty end
')
[[ -n "$comments_truncation" ]] && echo "$comments_truncation"

issue_md=$(echo "$conversation_json" | jq -r '
  .data.repository.pullRequest.comments.nodes
  | .[]
  | "- **\(.author.login // "deleted")** (\(.createdAt[0:10])): \((.body // "") | gsub("\\s+"; " ") | .[0:400])"
')

if [[ -z "$issue_md" ]]; then
    echo "_No issue-level discussion on this PR._"
else
    echo "$issue_md"
fi
