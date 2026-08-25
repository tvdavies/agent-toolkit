---
name: pr-review-table
description: List open PRs ordered by Linear priority with review status, action needed, and open conversations. Use when user says "PR table", "PR board", "open PRs", "review board", "PR status", "what PRs are open", "PR dashboard", or invokes /pr-review-table.
metadata:
  author: tvd
  version: 1.0.0
---

# PR Review Table

Generates a prioritised table of open pull requests with Linear issue context, review status, and action needed for each PR.

## Arguments

- `--days N`: Number of days to look back (default: 7)
- `--json`: Output raw JSON instead of a markdown table
- `--slack`: Output a Slack-formatted code block table

## Execution

Run the script from the skill's directory:

```bash
bash SKILL_DIR/scripts/pr-review-table.sh [ARGS]
```

Replace `SKILL_DIR` with the absolute path to this skill's directory (`~/.claude/skills/pr-review-table`).

Pass through any arguments the user provides (e.g. `--days 14`, `--json`, `--slack`).

## Dependencies

Requires `gh`, `jq`, and `curl` to be installed. Reads `LINEAR_API_KEY` from the environment or from `~/.config/linear-cli/config.toml`.

## Output

The script writes progress to stderr and the final table to stdout. Present the stdout output directly to the user. The default output is a markdown table with these columns:

| Column | Description |
|--------|-------------|
| Pri | Linear priority (Urgent, High, Medium, Low, None) |
| PR | PR number with link |
| Title | PR title (truncated) |
| Author | PR author |
| Approver | Assigned or implicit reviewer |
| Status | Action needed (Merge ready, Waiting for author, Waiting for reviewer, Needs reviewer) |
| Threads | Open (unresolved) review conversation count |
| Linear | Linked Linear issue IDs |
| Labels | Linear labels |
| State | Linear issue state |

## Error Handling

- If `LINEAR_API_KEY` is not found, the script exits with an error — inform the user to set it or install `linear-cli`.
- If no open PRs are found, report that cleanly.
- If `gh` is not authenticated, suggest running `gh auth login`.
