#!/usr/bin/env bash
set -eo pipefail

# Detect if we're in a git repo and get the owner/repo
CURRENT_REPO=""
if git rev-parse --is-inside-work-tree &>/dev/null; then
  CURRENT_REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
fi

# Fetch open PRs authored by me (including drafts)
if [ -n "$CURRENT_REPO" ]; then
  prs=$(gh search prs \
    --author=@me \
    --state=open \
    --repo "$CURRENT_REPO" \
    --json repository,title,url,number,createdAt \
    --jq '.')
else
  prs=$(gh search prs \
    --author=@me \
    --state=open \
    --json repository,title,url,number,createdAt \
    --jq '.')
fi

if [ -z "$prs" ] || [ "$prs" = "[]" ]; then
  echo '{"in_repo": false, "repo": "", "prs": []}'
  exit 0
fi

# For each PR, fetch reviewDecision and isDraft
echo "$prs" | jq -c '.[]' | while read -r pr; do
  repo=$(echo "$pr" | jq -r '.repository.nameWithOwner')
  number=$(echo "$pr" | jq -r '.number')

  details=$(gh pr view "$number" --repo "$repo" \
    --json reviewDecision,isDraft \
    --jq '{reviewDecision: (.reviewDecision // ""), isDraft: .isDraft}' 2>/dev/null || echo '{"reviewDecision":"","isDraft":false}')

  echo "$pr" | jq -c --argjson details "$details" '. + $details'
done | jq -s --arg current_repo "$CURRENT_REPO" '{in_repo: ($current_repo != ""), repo: $current_repo, prs: .}'
