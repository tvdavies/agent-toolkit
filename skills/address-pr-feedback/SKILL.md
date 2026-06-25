---
name: address-pr-feedback
description: Triage and address everything blocking a GitHub PR from merging — review comments, requested changes, merge conflicts, and CI failures. Use when the user says "address PR feedback", "handle review comments", "respond to the review", "address [reviewer]'s comments on #123", "fix the PR feedback", "make the PR mergeable", "unblock the PR", or "deal with the review". Fetches all unresolved threads, failing checks, and conflicts via gh, classifies each blocker as apply / discuss / decline, presents a unified plan for approval, then executes — applies code, pushes, posts replies, and resolves threads.
metadata:
  author: tvd
  version: 1.0.0
---

# Address PR Feedback

End-to-end workflow that takes a GitHub PR from "blocked" to "mergeable": triage every blocker once, present a single plan, execute on approval.

## Important

- **Never push code or post replies before the user approves the plan.** The triage-then-execute split is the whole point of this skill — do not skip it even when the fixes look obvious.
- **Default to applying.** "Decline" requires a concrete reason rooted in the code or the PR's intent — not "I disagree." If unsure, classify as "discuss" and ask the reviewer.
- **Group changes by logic, not by comment.** One commit per logical change. Reference the PR (not individual comment URLs) in commit messages.
- **Resolve threads only after the corresponding change is pushed.** Replying before the commit lands creates confusing review history.
- **Do not add top-level PR comments by default.** Prefer threaded replies via `reply-and-resolve.sh`. If a review item has no resolvable thread, handle it in code when appropriate and mention it in the final user summary; only post a top-level `gh pr comment` when the user explicitly asks or when a human reviewer needs a visible response.
- **Bot reviewers vs. human reviewers.** Threads from bots (CodeRabbit, Copilot, Greptile, Sourcery, etc. — the script flags these as `isBot: true`) should be resolved on every action — apply, discuss, decline — because bots will not re-engage. Threads from humans should only auto-resolve on `apply`; leave `discuss` / `decline` open so the reviewer can engage and resolve themselves.
- **Hand off merge conflicts to the `dev-bot:resolve-conflicts` skill** instead of resolving manually here.

## Step 1: Identify the PR

In order:
1. If the user named a PR number or URL, use it.
2. Otherwise run `gh pr view --json number,url -q '.number'` to detect the PR for the current branch.
3. If neither works, ask the user which PR.

## Step 2: Gather blockers

Run the bundled script:

    bash ~/.claude/skills/address-pr-feedback/scripts/fetch-pr-blockers.sh <pr-number>

It prints one JSON document with five sections:
- `pr` — number, title, base/head refs, `mergeable`, `mergeStateStatus`, `isDraft`, `url`
- `threads` — unresolved review threads, each with comment bodies, authors, paths, line numbers, the GraphQL `id` (for resolving) and the first comment's `databaseId` (for replying)
- `reviews` — reviews currently in `CHANGES_REQUESTED` state
- `checks` — failing / cancelled / timed-out checks with links
- `pending` — checks still running (pending / in-progress / queued / expected), so an empty `checks` is not mistaken for "all green" while CI is still in flight

Read every thread comment and every failing check log before triaging — do not skim. For check failures, fetch the log with `gh run view <run-id> --log-failed` (run id is in the check link) so the triage decision is based on the actual error, not the check name.

## Step 3: Triage

Build an internal table with one row per blocker. For each, decide:

**Comments / requested changes:**
- **apply** — the reviewer's point is correct and the fix is clear. The default.
- **discuss** — the reviewer asked a question, the right fix is ambiguous, or there's a tradeoff worth surfacing. Plan a reply asking the question; do not change code yet.
- **decline** — the suggestion is wrong, contradicts a verified codebase pattern, or is out of scope. Must come with a specific reason.

**Whether to resolve depends on the author**, surfaced in each thread as `isBot`:
- `isBot: true` (CodeRabbit, Copilot, Greptile, Sourcery, etc.) — resolve on every action. Bots will not re-engage; an open thread from a bot just blocks merge for no reason. For decline, post a one-line reason then resolve.
- `isBot: false` — resolve only on `apply`. For `discuss` / `decline`, post the reply but leave the thread open for the human to engage and resolve.

**CI failures:**
- Read the failed step's log. Identify the root cause (test failure, lint, type error, build break, flake).
- Plan the minimal fix. If it's a flake with no real signal, plan a `gh run rerun <run-id>` instead of code changes — and say so explicitly in the plan.

**Merge conflicts:**
- If `pr.mergeable == "CONFLICTING"` or `mergeStateStatus == "DIRTY"`, plan a hand-off to the `dev-bot:resolve-conflicts` skill. Do not attempt manual conflict resolution from this skill.

## Step 4: Present the plan

Show the user a single compact table. Suggested format:

    | # | Source            | Item                          | Action  | Notes                          |
    | 1 | Daisy (line 42)   | "Use existing helper"         | apply   | replace inline with formatX()  |
    | 2 | Daisy (line 88)   | "Why not memoize?"            | discuss | ask: deps change every render? |
    | 3 | CI: typecheck     | TS2345 in src/foo.ts          | apply   | add type guard                 |
    | 4 | Merge state       | conflict with main            | apply   | delegate to resolve-conflicts  |

Then ask: "Run this plan?" Wait for approval. Treat "yes / go / lgtm / proceed / ship it" as approval; anything else means iterate. If the user changes a row's action or asks to add context to a reply, update the plan and re-show before executing.

## Step 5: Execute

Order matters:

1. **Resolve conflicts first** if any (clean working tree before applying changes).
2. **Apply code changes** for "apply" rows. Group by logical change, not by comment. Run the project's typecheck/test/lint locally if quick; if anything breaks, stop and re-triage instead of barrelling through.
3. **Commit and push** to the PR branch. Clear messages, no force-push without asking the user.
4. **For each thread**, run:

       bash ~/.claude/skills/address-pr-feedback/scripts/reply-and-resolve.sh <pr> <thread-id> <first-comment-database-id> "<reply body>" [--no-resolve]

   Pass `--no-resolve` when the thread should stay open. Decision matrix:

   | Action  | Bot author (`isBot: true`) | Human author |
   | ------- | -------------------------- | ------------ |
   | apply   | resolve                    | resolve      |
   | discuss | resolve                    | `--no-resolve` |
   | decline | resolve                    | `--no-resolve` |

   - For `apply`: reply with `"Done in <short-sha>."` or a one-liner explaining the fix.
   - For `discuss`: reply with the question.
   - For `decline`: reply with the reasoning.

5. **For non-threaded review items**, do not leave a top-level PR comment by default. Track what was fixed, declined, or left for re-review in the final user summary. If the user explicitly wants a public response, or a human reviewer needs an answer that cannot be posted in-thread, use `gh pr comment`.
6. **For CI failures fixed by code**, the new push triggers reruns automatically. For pure flakes, `gh run rerun <run-id>`.

## Step 6: Verify

Re-run `fetch-pr-blockers.sh <pr-number>`. Summarize for the user:
- Threads — resolved vs. still open (and why each open one is open: discuss or decline)
- Reviews — any still in `CHANGES_REQUESTED`? If so, the reviewer needs to re-review; nudge the user to request it with `gh pr review --request <reviewer>` (or via the GitHub UI).
- Checks — pending / passing / failing
- Mergeable — yes / no

If anything new appeared (a check started failing, a new comment landed), loop back to Step 3.

## Examples

### Example 1: Standard "address feedback" pass
User: "address Daisy's comments on PR #847"
1. `fetch-pr-blockers.sh 847` returns 5 unresolved threads, 1 failing typecheck, no conflicts.
2. Triage: 4 apply, 1 discuss, typecheck = apply (missing import).
3. Present plan; user says "yes."
4. Apply 4 fixes + the import → one commit, push.
5. For 4 threads: reply "Done in abc123." + resolve. For the discuss thread: reply with the question, no resolve.
6. Verify: 1 thread open (the discuss one), checks green, mergeable. Done.

### Example 2: PR with a conflict
User: "make PR 901 mergeable"
1. Fetch shows `mergeStateStatus: DIRTY`, 2 unresolved threads, checks green.
2. Plan row 1: hand off to `dev-bot:resolve-conflicts`. Rows 2-3: apply both comments.
3. After approval, invoke `dev-bot:resolve-conflicts` first, then apply comment fixes on top, push once, reply+resolve both threads.

### Example 3: Flaky CI, no real comments
User: "unblock PR 1024"
1. Fetch shows 0 threads, but `e2e-tests` failing on a known flaky spec.
2. Read the log — it's the same intermittent timeout on the websocket reconnect test.
3. Plan row 1: rerun the failed job, no code change. Note in the plan that this is a known flake.
4. After approval, `gh run rerun <id>`. Verify when checks complete.

## Common Issues

### `fetch-pr-blockers.sh` errors with `jq: command not found`
The script needs both `gh` and `jq`. Install jq (`pacman -S jq` on Arch). Verify with `gh --version && jq --version`.

### Reply posts but thread doesn't resolve
The thread `id` is the GraphQL node ID (looks like `PRRT_kw...`), distinct from the comment `databaseId` (an integer). The script takes both — make sure they aren't swapped.

### `Resource not accessible by integration` on resolve
The current `gh` auth scope is missing what's needed to mutate review threads. Run `gh auth refresh -s repo` and retry.

### Push rejected (non-fast-forward)
Someone else pushed to the branch. `git pull --rebase`, re-run typecheck/tests, push again. Do not force-push without explicit user approval.

### Reviewer left a top-level review comment (not on a line)
Top-level review comments don't appear as review threads — they show up under `reviews`. There's no thread to resolve. Do not add a regular PR comment by default; fix or triage the item and surface the outcome in the final user summary. Only use `gh pr comment <pr> --body "..."` when the user explicitly asks for a public response or a human reviewer needs an answer.
