---
name: prsmash-history
description: Answer questions about PRs reviewed by prsmash, including whether a PR was approved, changes requested, commented on, errored, or what findings/suggestions were raised. Use when the user asks about past prsmash reviews, reviewed PR history, what was wrong with a PR, whether we approved a PR, or references questions like "what happened with PR 4811", "tell me what was wrong with PR 4811 again", "did we approve 4800", "show the last review for PR 4800", or "what did prsmash say".
metadata:
  author: tvd
  version: 1.0.0
---

# PRSmash History

Use this skill to answer questions about reviews performed by `prsmash`.

## Data Location

`prsmash` stores logs under:

```bash
~/.prsmash
```

Important paths:

- `~/.prsmash/runs/YYYYMMDD-HHMMSS/` — one directory per prsmash run
- `~/.prsmash/latest` — symlink to the most recent run
- `~/.prsmash/hourly.log` — wrapper output from the hourly systemd timer

Inside each run directory:

- `prsmash.log` — overall run output and per-PR summary lines
- `queue.json` — review queue snapshot used for the run
- `pr-<number>-<repo>.log` — full Pi/pr-review output for that PR
- `pr-<number>.status` — machine-readable result, formatted as `OK|STATE|DURATION_SECONDS` or `ERR||DURATION_SECONDS`
- `summary.txt` — run totals

GitHub review states in status files:

- `APPROVED` — PR was approved
- `CHANGES_REQUESTED` — changes were requested
- `COMMENTED` or another state — review/comment was posted but it did not approve or request changes
- `UNKNOWN` — prsmash completed but could not determine the resulting GitHub state
- `ERR` result — prsmash failed for that PR; inspect the PR log

## How to Investigate

### 1. Identify the PR number

Extract the PR number from the user's request. If no PR number is given, ask a concise follow-up unless the user is asking for a general summary.

### 2. Find matching run files

Prefer `rg` because logs can grow large.

For a specific PR number:

```bash
PR=4811
find ~/.prsmash/runs -type f \( -name "pr-${PR}*.log" -o -name "pr-${PR}.status" \) | sort
```

To find mentions across all run summaries and queue snapshots:

```bash
rg -n "#?${PR}\b|pr-${PR}|\"number\":\s*${PR}" ~/.prsmash
```

To see the most recent review log for a PR:

```bash
PR=4811
find ~/.prsmash/runs -type f -name "pr-${PR}*.log" | sort | tail -1
```

To see all attempts for a PR, oldest to newest:

```bash
PR=4811
find ~/.prsmash/runs -type f -name "pr-${PR}*.log" | sort
```

### 3. Determine whether the PR was approved

Check the corresponding status files first:

```bash
PR=4811
find ~/.prsmash/runs -type f -name "pr-${PR}.status" -print -exec cat {} \; | sort
```

A status of `OK|APPROVED|...` means yes, prsmash approved it. `OK|CHANGES_REQUESTED|...` means no, changes were requested. `ERR||...` means the run failed.

Also check `prsmash.log` summary lines when useful:

```bash
rg -n "#${PR}\b|Approved|Changes requested|Commented|Error" ~/.prsmash/runs/*/prsmash.log
```

### 4. Explain what was wrong with a PR

Open the relevant `pr-<number>-<repo>.log`, usually the latest one unless the user asks for a specific run.

Useful searches inside a PR log:

```bash
LOG=/path/to/pr-4811-owner__repo.log
rg -n "Verdict|Changes Requested|Approved with Suggestions|Approved|Critical|Should Fix|Suggestions|File:|Lines:|what|why|fix|REQUEST_CHANGES|APPROVE_WITH_SUGGESTIONS|APPROVE" "$LOG"
```

If the log includes a generated GitHub review body, summarise from that. Look for headings like:

- `## 🔴 Changes Requested`
- `## 🔵 Approved with Suggestions`
- `## ✅ Approved`
- `### 🔵 Suggestions`
- `Critical Issues`
- `Should Fix`
- `Suggestions`

For Pi/tool output noise, ignore internal progress unless it explains a failure.

### 5. Cross-check GitHub if local logs are inconclusive

If logs are missing, truncated, or ambiguous, use GitHub CLI from the relevant repository:

```bash
gh pr view PR_NUMBER --json number,title,url,state,reviewDecision,latestReviews

gh api --paginate --slurp "repos/OWNER/REPO/pulls/PR_NUMBER/reviews" \
  | jq -r '[.[] | .[]] | sort_by(.submitted_at) | .[] | [.submitted_at, .user.login, .state, (.body // "" | split("\n")[0])] | @tsv'
```

Use GitHub data as a fallback or confirmation, but prefer `~/.prsmash` for questions about what prsmash specifically did or said.

## Answer Style

Be concise and concrete.

For "Did we approve PR N?", answer:

- Yes/no/unclear
- Latest relevant run timestamp
- Result state
- Link/path to the log inspected

For "What was wrong with PR N?", answer:

- Verdict from the latest relevant review
- Bullet list of critical/should-fix findings and suggestions
- Mention if there were no blockers and only suggestions
- Include the log path so the user can inspect details

For failures, include:

- Whether prsmash errored
- The likely error from the log
- The log path

Do not invent review findings. If the log does not contain enough information, say so and state exactly what was checked.
