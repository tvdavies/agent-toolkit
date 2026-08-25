---
name: my-prs
description: Shows open PRs authored by you with their review status. Use when user says "my prs", "my pull requests", "my open prs", "what prs did I open", "pr status", "my drafts", "where are my PRs", "my PR status", or "prs I opened".
metadata:
  author: tvd
  version: 1.0.0
---

# My PRs

## Instructions

1. Run `~/.claude/skills/my-prs/scripts/my-prs.sh`
2. The output JSON has `in_repo` (boolean), `repo` (string), and `prs` (array)
3. If `in_repo` is true, show a table with columns: #, Title (linked), Draft, Review Status, Age
4. If `in_repo` is false, show a table with columns: Repo, #, Title (linked), Draft, Review Status, Age
5. Draft column: "Yes" if `isDraft` is true, blank otherwise
6. Review Status column mapping:
   - `CHANGES_REQUESTED` → "Changes Requested"
   - `APPROVED` → "Approved"
   - `REVIEW_REQUIRED` → "Awaiting Review"
   - empty string → blank
7. Age: human-readable relative time from `createdAt`
8. If there are no PRs, say "You have no open PRs."
