#!/usr/bin/env bash
# reply-and-resolve.sh — post a reply to a PR review thread, then (by default) resolve it.
#
# Usage: reply-and-resolve.sh <pr-number> <thread-graphql-id> <first-comment-database-id> <reply-body> [--no-resolve]
#
# - <thread-graphql-id> is the `id` field from the GraphQL reviewThreads query (e.g. PRRT_kw...).
# - <first-comment-database-id> is the integer `databaseId` of any comment in the thread (used
#   for the REST reply endpoint). Replying to any comment in the thread posts to the thread.
# - Pass --no-resolve to skip resolution (use for "discuss" / "decline" replies that should
#   stay open for the reviewer to handle).

set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "usage: reply-and-resolve.sh <pr> <thread-id> <first-comment-database-id> <body> [--no-resolve]" >&2
  exit 64
fi

command -v gh >/dev/null || { echo "reply-and-resolve: 'gh' not found" >&2; exit 127; }
command -v jq >/dev/null || { echo "reply-and-resolve: 'jq' not found" >&2; exit 127; }

pr="$1"
thread_id="$2"
comment_id="$3"
body="$4"
resolve=true
[[ "${5:-}" == "--no-resolve" ]] && resolve=false

repo_info=$(gh repo view --json owner,name)
owner=$(jq -r .owner.login <<<"$repo_info")
name=$(jq -r .name <<<"$repo_info")

reply_url=$(gh api -X POST "repos/$owner/$name/pulls/$pr/comments/$comment_id/replies" \
  -f body="$body" --jq '.html_url')

if [[ "$resolve" == "true" ]]; then
  resolved=$(gh api graphql -F threadId="$thread_id" -f query='
    mutation($threadId:ID!) {
      resolveReviewThread(input:{threadId:$threadId}) {
        thread { isResolved }
      }
    }' --jq '.data.resolveReviewThread.thread.isResolved')
else
  resolved="skipped"
fi

jq -n --arg reply "$reply_url" --arg resolved "$resolved" \
  '{reply_url: $reply, resolved: $resolved}'
