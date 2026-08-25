# Pull Request Readiness Protocol

This is the canonical blocker, feedback, and merge-readiness contract shared by `address-pr-feedback` and `start-ticket`. Caller-specific instructions decide whether to ask for approval, act autonomously, or pause and resume. If caller instructions conflict with blocker classification, thread resolution, push ordering, or readiness criteria here, this protocol wins.

## Inputs

Run all commands from the checkout for the PR head branch or pass an explicit repository to `gh`. Never infer a PR from an unrelated checkout.

The shared scripts are in `scripts/` beside this file:

```bash
bash scripts/fetch-pr-blockers.sh PR_NUMBER
bash scripts/reply-and-resolve.sh PR_NUMBER THREAD_ID FIRST_COMMENT_DATABASE_ID "REPLY" [--no-resolve]
```

`fetch-pr-blockers.sh` returns one JSON document:

- `pr`: number, title, base/head refs, draft state, URL, mergeability, and merge-state status
- `threads`: unresolved review threads with GraphQL thread ID, first comment database ID, author, bot classification, path, line, and full comments
- `reviews`: reviews currently in `CHANGES_REQUESTED`
- `checks`: failed, cancelled, or timed-out checks
- `pending`: queued, expected, pending, or in-progress checks

The script output is a blocker inventory, not sufficient proof that a PR is green.

## Authoritative state

After fetching blockers, query current GitHub state for the same PR and head commit:

```bash
gh pr view PR_NUMBER --json reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,headRefOid,reviews,comments
```

Classify checks from `statusCheckRollup`:

- `FAILED`: any required/relevant check concludes `FAILURE`, `CANCELLED`, `TIMED_OUT`, or `ACTION_REQUIRED`
- `PENDING`: any check is `QUEUED`, `IN_PROGRESS`, `PENDING`, or `EXPECTED`
- `GREEN`: all required/relevant checks are `SUCCESS`, `NEUTRAL`, or `SKIPPED`

An empty rollup is not automatically green. If the repository normally runs checks or branch protection expects them, treat an empty rollup on a new head as pending. It may count as green only when repository policy clearly requires no checks.

When the repository uses an automated reviewer, verify that it reviewed the current `headRefOid`; feedback on an older head is stale evidence.

## Triage

Read every unresolved thread and every failed-check log before deciding an action.

Review feedback actions:

- `apply`: default when the point is correct and the fix is clear
- `discuss`: a real question, ambiguity, or tradeoff requires reviewer input
- `decline`: the suggestion conflicts with verified code, requirements, or scope; include a specific code-grounded reason

CI actions:

- Read the failing job log and fix the root cause.
- If evidence shows a pure infrastructure or test flake, rerun the failed job rather than changing code.
- A new push restarts CI and invalidates readiness evidence for the previous head.

Conflicts:

- Resolve against the current base using repository policy.
- Never force-push unless the user separately gives explicit permission.
- Escalate conflicts that cannot be resolved safely.

## Execution ordering

For every applied item:

1. Change code in the PR worktree.
2. Run relevant local validation.
3. Commit and push to the PR head branch.
4. Only after the pushed commit exists, reply to the review thread.
5. Resolve according to the matrix below.
6. Re-fetch blockers and authoritative state for the new head.

Never resolve a thread before its fix is pushed.

| Action | Bot author | Human author |
| --- | --- | --- |
| apply | reply and resolve | reply and resolve |
| discuss | reply and resolve | reply with `--no-resolve` |
| decline | reply and resolve | reply with `--no-resolve` |

Bots do not normally re-engage, so leaving their handled thread open creates a stale blocker. Humans own resolution when the response asks for discussion or declines their suggestion.

For applied feedback, use a concise reply such as `Done in SHORT_SHA.` For discuss or decline, state the question or reason directly.

Top-level review comments have no resolvable thread. Apply or triage them, but do not post a redundant top-level PR comment unless the caller explicitly requires a public response or a human reviewer needs an answer that cannot be posted in-thread.

## Ready-to-merge criteria

A PR is ready only when all applicable conditions hold for the current head:

- it is non-draft unless the caller intentionally manages drafts
- no unresolved actionable review threads remain
- no active `CHANGES_REQUESTED` review remains
- required/relevant checks are green, not absent or pending
- expected automated review has examined the current head
- `mergeable` is `MERGEABLE`
- `mergeStateStatus` is not `BLOCKED`, `DIRTY`, or `BEHIND`
- required human approval is present, or repository policy reports review is not required
- the PR branch is pushed and its worktree has no uncommitted intended changes

The absence of failing checks or unresolved threads alone is never enough to declare readiness.

## Loop and exit rules

- Re-check after each push because the head, checks, and automated-review evidence changed.
- Do not busy-poll. Use a watch, park, scheduled resume, or background mechanism with at least 60 seconds between remote status checks.
- If only external CI or human review is pending and no resumable wait exists, return the exact pending state; do not pretend the PR is ready.
- Stop after roughly three no-progress cycles, a repeatedly failing check with no verified fix, unsafe conflict resolution, or a human decision the agent cannot make safely.
- Never merge the PR as part of this protocol.
