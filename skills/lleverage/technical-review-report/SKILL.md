---
name: technical-review-report
description: Generate a team-wide Linear Technical Review report enriched with GitHub PR state. Use when the user asks for technical review context, tech review report, who needs to act on review tickets, current cycle review status, tickets in technical review, or review bottlenecks.
metadata:
  author: tvd
  version: 1.0.0
---

# Technical Review Report

Generates a current-cycle report for Linear issues in `Technical Review`, enriched with related GitHub PR status.

## Usage

```bash
~/.agents/skills/technical-review-report/scripts/technical-review-report.sh
~/.agents/skills/technical-review-report/scripts/technical-review-report.sh --team LLE --repo lleverage-ai/lleverage
~/.agents/skills/technical-review-report/scripts/technical-review-report.sh --format json
~/.agents/skills/technical-review-report/scripts/technical-review-report.sh --all-tech-review
```

Defaults:

- Linear team: `LLE`
- Linear state: `Technical Review`
- GitHub repo: auto-detected from the current git repo, otherwise `lleverage-ai/lleverage`
- Scope: current Linear cycle
- Output: Markdown

## Interpretation

The script classifies each ticket by the most likely next action:

- **Assignee/author**: no PR, draft PR, merge conflicts, failing/pending checks, changes requested, unresolved review threads, or approved-but-not-merged.
- **Reviewer(s)**: GitHub has explicit requested reviewers and no stronger author-side blocker.
- **Unclear**: PR state does not make the next actor obvious.

It also surfaces:

- Review decision (`APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`)
- Requested reviewers
- Unresolved review thread count
- Check summary
- Merge state / conflict signal
- Draft state
- Other Linear ticket IDs referenced by the same PR, useful where one PR covers multiple tickets.

Use this report to replace raw Linear counts like “39 tickets in technical review” with “who needs to do what next”.
