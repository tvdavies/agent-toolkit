# Pull Request Readiness Protocol

This is the canonical blocker, feedback, and merge-readiness contract used by `babysit-pr` and by `yolo-ticket` during its babysitting phase. Those callers act autonomously within their explicit scope and may pause or resume while external state changes. `start-ticket` stops before this remote-review lifecycle. If caller instructions conflict with worktree isolation, blocker classification, thread resolution, push ordering, or readiness criteria here, this protocol wins. The yolo wrapper's separately authorised normal auto-merge request occurs outside this protocol; this protocol itself never merges.

## Inputs

Pass an explicit repository to `gh` after identifying the PR. Never infer a PR from an unrelated checkout.

## Worktree isolation

Read-only PR discovery may happen in the primary checkout. Before any dependency installation, formatting, build, test, code generation, edit, commit, conflict resolution, or other command that may change repository state, establish a dedicated non-primary managed worktree for the PR head.

- Inspect existing worktrees first and reuse only the managed worktree that belongs to this PR.
- Never treat the primary checkout as the PR worktree, even when it already has the PR branch checked out.
- Verify the selected absolute path against `git worktree list --porcelain` before mutation.
- If direct adoption resolves to the primary checkout, create a managed worktree from the exact current PR head SHA on a temporary local branch. Push it only with an explicit refspec to the real PR head branch after confirming that the remote head SHA has not moved.
- Run all code-related commands in that worktree and keep one writer across feedback cycles.
- For fork PRs, push only to the actual head repository. Missing permission is a blocker, not permission to push elsewhere.
- Preserve dirty or blocked worktrees. Remove one only when it is clean and all intended commits are confirmed pushed.

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

### Automated review request policy

Necessary manual review and re-review requests are part of authorised PR babysitting. When automatic reviews are paused or current-head coverage is missing, use the provider's existing manual review command without asking the user for separate approval.

Review budgets, included usage and additional usage billing are managed outside the agent. Do not estimate review charges, maintain spending reservations, enforce review-wave caps, or pause publication or review requests to ask about billing. Historical task budget notes are not PR-review permission gates. File counts, plan labels, remaining-usage indicators and old receipts do not reliably establish whether a request is included or additionally billed; do not claim that it is free or incurs a specific charge.

Before requesting a review, verify the current head and check for a request or review already in progress. If the user or another actor has already triggered that review, observe it rather than issuing a duplicate. Do not request another review of an unchanged head that already has valid coverage without a concrete review need.

Use the existing review route only. This policy does not authorise changing subscriptions, buying credits, raising spending caps, or changing billing or automatic-review settings. Report actual provider access failures or rejections; do not turn uncertainty about usage billing into an invented blocker. Current-head review, required human approval and the no-merge rule remain unchanged.

## Triage

Read every unresolved thread and every failed-check log before deciding an action.

Review feedback actions:

- `apply`: default when the point is correct and the fix is clear
- `acknowledge`: the point is valid or informational but needs no code change (already handled, intentional, or out of scope with a named follow-up); say why in the reply
- `discuss`: a real question, ambiguity, or tradeoff requires reviewer input
- `decline`: the suggestion conflicts with verified code, requirements, or scope; include a specific code-grounded reason

CI actions:

- Read the failing job log and fix the root cause.
- If evidence shows a pure infrastructure or test flake, rerun the failed job rather than changing code.
- A new push restarts CI and invalidates readiness evidence for the previous head.

Conflicts:

- Resolve against the current base using repository policy.
- Never force-push. If safe conflict resolution would require rewriting the PR branch, stop and report the blocker.
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

### Every conversation ends with a reply and a resolve

Every review thread on the PR, human or bot, must end resolved, and never without a reply that says what happened. A reply does not require a code change: make one only when the feedback warrants it. An unanswered or unresolved thread is never an acceptable end state, and a green PR with open threads is not ready. Repositories commonly enforce this through required conversation resolution, so an open thread is a merge blocker, not a courtesy.

| Action | Reply | Then |
| --- | --- | --- |
| apply | what changed, with the pushed SHA | resolve |
| acknowledge | why no change is needed (or the follow-up ticket) | resolve |
| decline | the code- or requirement-based reason | resolve |
| discuss | the concrete question | leave open **only** until the reviewer answers, then apply, acknowledge or decline, reply and resolve |

- Resolve immediately after replying for `apply`, `acknowledge` and `decline`, whether the author is a bot or a human. The reply records the reasoning; the resolve clears the blocker. A reviewer who disagrees can reopen the thread or comment again, and that wakes the next cycle.
- Use `--no-resolve` only for a `discuss` reply that asks the reviewer something the agent cannot decide safely. Track it as an open question: when the reviewer answers, act on the answer and resolve. If the inactivity budget ends first, report it as the pending question, never as "done".
- When a later comment or push changes a previous answer, correct the reply in the thread before resolving it.
- Before claiming `READY TO MERGE`, re-query every thread (not only the blocker inventory) and verify that none is unresolved and none lacks a reply. Resolve any handled thread left open by an earlier cycle, after replying if it has no reply.

For applied feedback, use a concise reply such as `Done in SHORT_SHA.` For acknowledge, decline or discuss, state the reason or question directly.

Top-level review comments have no resolvable thread. Apply or triage them, but do not post a redundant top-level PR comment unless the caller explicitly requires a public response or a human reviewer needs an answer that cannot be posted in-thread.

## Ready-to-merge criteria

A PR is ready only when all applicable conditions hold for the current head:

- it is non-draft unless the caller intentionally manages drafts
- every review thread is resolved, each with a reply that records the outcome (see "Every conversation ends with a reply and a resolve")
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
- Do not spend agent turns on repeated `sleep` and status-check cycles. `babysit-pr` must use its blocking `wait-for-pr-change.sh` watcher with at least 60 seconds between remote polls; other callers should use an equivalent watch, park, or scheduled resume.
- Build the waiting baseline from the same canonical snapshot used for the final actionable-state decision. Inspect that snapshot before waiting so a change is not hidden inside a newly captured baseline.
- If only external CI or human review is pending and no resumable wait exists, return the exact pending state; do not pretend the PR is ready.
- Stop after roughly three no-progress cycles, a repeatedly failing check with no verified fix, unsafe conflict resolution, or a human decision the agent cannot make safely.
- Stop successfully when the PR is ready to merge or already merged. Never merge the PR as part of this protocol.
