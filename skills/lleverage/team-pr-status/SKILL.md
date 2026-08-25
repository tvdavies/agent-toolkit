---
name: team-pr-status
description: Team-wide PR status dashboard grouped by reviewer. Shows who needs to look at which PRs, plus author action items. Use when user says "team PR status", "who needs to review what", "PR assignments", "team review dashboard", "who is blocking PRs", "review workload", "team PRs", or "PR report".
metadata:
  author: tvd
  version: 1.0.0
---

# Team PR Status

Generates a per-person breakdown of open PRs across the team. For each team member, shows:
1. PRs they need to review (fresh or re-review)
2. PRs they authored that need their attention (changes requested, open threads)
3. PRs they authored that are merge-ready

## Arguments

- `--days N`: Number of days to look back (default: 7)
- `--json`: Output raw JSON for programmatic use
- `--slack`: Output Slack-formatted text

## Execution

```bash
bash SKILL_DIR/scripts/team-pr-status.sh [ARGS]
```

Replace `SKILL_DIR` with the absolute path to this skill's directory.

## Dependencies

Requires `gh`, `jq`, and `curl`. Reads `LINEAR_API_KEY` from env or `~/.config/linear-cli/config.toml` for priority data. Team members default to `corixdean`, `GSasu`, `jaythegeek`, `tvdavies` — override via `TEAM_MEMBERS` env (comma-separated).

## Output

The script writes progress to stderr and JSON to stdout.

### JSON Structure

An array of objects, one per team member:

```json
[
  {
    "reviewer": "username",
    "prs_to_review": [
      {
        "number": 123,
        "title": "PR title",
        "author": "author_login",
        "url": "https://github.com/...",
        "priority": 2,
        "priority_label": "High",
        "linear_ids": "LLE-123",
        "open_conversations": 0,
        "review_type": "fresh"
      }
    ],
    "prs_authored_needing_action": [
      {
        "number": 456,
        "title": "Another PR",
        "url": "https://github.com/...",
        "priority": 3,
        "priority_label": "Medium",
        "open_conversations": 2,
        "changes_from": ["reviewer_login"]
      }
    ],
    "prs_merge_ready": [
      { "number": 789, "title": "Ready PR", "url": "https://github.com/..." }
    ]
  }
]
```

### Presenting Results

Present the output as a **per-person summary**. For each team member:

1. **Heading**: Use their GitHub username as the section heading
2. **Reviews needed** (`prs_to_review`): Show as a table with columns: Pri, PR (#, linked), Title, Author, Type (fresh/re-review). Sort by priority. If empty, say "No reviews pending."
3. **Author action needed** (`prs_authored_needing_action`): List PRs where they need to address feedback. Show open conversation count and who requested changes. If empty, skip this section.
4. **Merge ready** (`prs_merge_ready`): Brief list of PRs ready to merge. If empty, skip.
5. At the top, show a **summary line** counting total reviews pending per person so the user can quickly see workload distribution.

### Priority Icons

| Priority | Icon |
|----------|------|
| 1 (Urgent) | Red |
| 2 (High) | Orange |
| 3 (Medium) | Yellow |
| 4 (Low) | Blue |
| 5 (None) | Grey |

## Error Handling

- If `LINEAR_API_KEY` is missing, the script still works but priorities default to "No priority"
- If `gh` is not authenticated, suggest running `gh auth login`
- If no PRs found, report cleanly
