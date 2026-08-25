---
name: babysit-pr
description: Autonomously monitors a GitHub pull request and keeps it moving toward merge readiness. Use only when the user explicitly asks to "babysit PR", "watch this PR", "monitor this PR", "keep this PR moving", "address PR feedback", "handle review comments", "fix PR feedback", "make this PR mergeable", or "unblock this PR" for a named PR or the unambiguous current PR. Handles reviews, comments, checks, flakes, and conflicts; may commit and push fixes to the PR head branch, but never merges.
compatibility: Requires git, GitHub CLI, jq, network access, and a repository with worktree support.
disable-model-invocation: true
metadata:
  author: tvd
  version: 1.1.0
---

# Babysit PR

Use this skill only after the user explicitly asks to babysit, watch, monitor, address feedback on, make mergeable, or unblock a named PR or the unambiguous current PR. That explicit invocation authorises routine remediation for this PR: inspect feedback and logs, edit code in an isolated worktree, validate, commit, push to the PR head branch, reply to reviewers, resolve handled threads, and rerun verified flakes. Work autonomously until the PR is ready to merge, already merged, precisely blocked, or nothing has happened on the PR for the full inactivity budget defined in Phase 5; do not present a plan or pause for routine confirmation.

## Non-negotiable rules

- Never merge the pull request.
- Never force-push, push to a protected branch, or redirect work to a different branch because the intended head is unavailable.
- Never run dependency installation, formatting, builds, tests, code generation, edits, commits, or conflict resolution in the primary checkout. Those commands belong in a dedicated managed worktree.
- Read-only discovery may happen in the primary checkout before isolation. After selecting the worktree, keep every code-related command anchored to its absolute path.
- Re-fetch the remote PR head SHA immediately before every push. If it moved, integrate the new head safely and revalidate before pushing.
- Keep one writer and the same worktree across monitoring cycles. Do not discard dirty work or create competing worktrees.
- Resolve a review thread only after the corresponding pushed commit exists.
- Stop on unsafe ambiguity, unavailable push permission, repeated no-progress, or an operation that would require violating these rules.

## Invocation target — process first

Pi appends slash-command arguments to the loaded skill as `User: ARGUMENTS`. Treat that appended text as the user's explicit request, even when it is only a number and contains no prose.

- `User: 6334` and `User: #6334` both select PR 6334.
- `/babysit-pr 6334` and `/skill:babysit-pr 6334` both mean: babysit PR 6334 in the repository identified by a supplied URL or the current trusted repository context.
- A GitHub pull-request URL is an explicit target and supplies both repository and PR number.
- `/babysit-pr` or `/skill:babysit-pr` with no argument means: derive the PR from the current branch, but only when that branch maps unambiguously to one PR.

Resolve the target in this order:

1. Slash-command invocation arguments appended as `User: ARGUMENTS`.
2. An explicit PR number or URL in the surrounding user message.
3. The PR associated with the current branch, only when no explicit target was supplied.

Never inspect the current branch to choose a different PR, or ask which PR the user meant, when valid invocation arguments already contain a number or URL. If a bare number was supplied but no repository can be identified safely, retain that number and ask only which repository contains it.

## Shared skills and protocol

1. Resolve this skill directory from the loaded `SKILL.md` path and call it `SKILL_DIR`.
2. Load the installed `worktrees` skill by name before creating, adopting, reusing, or removing a worktree. Its generic worktree mechanics are authoritative.
3. Read `$SKILL_DIR/../_shared/pr-readiness/PROTOCOL.md`. Follow its blocker classification, current-head readiness criteria, push-before-resolve ordering, bot/human handling, and no-merge rule.
4. Before posting any reply or top-level comment, load the installed `writing-for-humans` skill by name and apply its send-ready process.

Use the shared scripts for blocker inventory and thread replies:

```bash
bash "$SKILL_DIR/../_shared/pr-readiness/scripts/fetch-pr-blockers.sh" PR_NUMBER
bash "$SKILL_DIR/../_shared/pr-readiness/scripts/reply-and-resolve.sh" PR_NUMBER THREAD_ID COMMENT_DATABASE_ID "REPLY" [--no-resolve]
```

## Phase 1: Identify the exact PR

Apply the invocation-target order above before any branch lookup. A bare positive integer from `User: ARGUMENTS` is already an explicit PR number; do not discard it because it lacks prose. When no number or URL was supplied, derive the PR only when the current branch unambiguously has one. Record the repository explicitly so later `gh` calls do not depend on the current directory.

Fetch at least:

```bash
gh pr view PR_NUMBER --repo OWNER/REPO \
  --json number,url,state,isDraft,mergedAt,closedAt,headRefOid,headRefName,headRepository,headRepositoryOwner,isCrossRepository,baseRefName,mergeable,mergeStateStatus,reviewDecision
```

Record:

- PR number and `OWNER/REPO`
- current `headRefOid` and `headRefName`
- head repository and owner, including whether it is a fork
- base branch
- open, draft, closed, or merged state

If the PR is merged, report `MERGED` and stop. If it is closed without merging, report `CLOSED UNMERGED` and stop. Do not reopen, retarget, or merge it.

## Phase 2: Establish or reuse a dedicated worktree

Do this before any code-related command, even when the PR branch is already checked out somewhere. Prefer the worktree you are already in when it is the correct isolated PR workspace; do not create redundant worktrees.

1. **Inspect the current checkout before calling `worktree_list`, `worktree_adopt`, or `worktree_new`.** With read-only Git commands, record its absolute repository root, its entry in `git worktree list --porcelain`, whether it is the primary checkout, current branch, upstream, HEAD, and `git status --porcelain`.
2. Reuse the current checkout immediately as `WT` when it is a dedicated non-primary managed worktree and is clearly associated with this PR through the PR head branch, its upstream, its relationship to `headRefOid`, or preserved implementation context from this task. Do not call `worktree_adopt` or `worktree_new` in this case.
3. Do not require local `HEAD` to equal the remote `headRefOid` when the current worktree contains intended local commits or dirty implementation work for this PR. Preserve and inspect that work. Determine whether local state is ahead, behind, or diverged from the fetched PR head before editing or pushing:
   - If it is clean and only behind, update it safely in `WT`.
   - If it is ahead or dirty with intended PR work, continue from it without discarding or duplicating the work.
   - If the remote moved while intended local work exists, reconcile in `WT`, reconsider affected feedback, and revalidate before pushing.
   - If its association or dirty work is unrelated or ambiguous, preserve it and continue with the fallback below rather than repurposing it.
4. When the current checkout cannot be reused, call `worktree_list`. Reuse another existing worktree only when it belongs to this PR, is outside the primary checkout, and is under the configured managed worktree root.
5. Otherwise call `worktree_adopt` with the PR number and repository.
6. Verify the returned absolute path against `git worktree list --porcelain` and the managed worktree root. The current adoption helper may return the primary checkout when the PR branch is already checked out there. Detect that before running any mutating command.
7. If adoption returned the primary checkout, do not use it. Ensure the exact PR head object exists locally without changing primary-checkout files. If necessary, fetch the GitHub PR head ref with the equivalent of `git fetch origin pull/PR_NUMBER/head`, verify `FETCH_HEAD` equals the recorded `headRefOid`, and restart discovery if it moved. Then call `worktree_new` with a unique name such as `babysit-pr-PR_NUMBER` and `base` set to that exact `headRefOid`. This creates a temporary local branch at the PR head. Record that pushes must use an explicit refspec:

   ```bash
   git push HEAD:PR_HEAD_BRANCH
   ```

8. For a fork PR, configure or select a remote for the actual head repository. Verify authenticated push access before editing. If the head repository cannot be pushed, stop with `BLOCKED: no push access to HEAD_REPOSITORY`; do not push the work to the base repository or another branch.
9. Record the selected absolute path as `WT`. Run `git status --porcelain`, `git rev-parse HEAD`, `git branch --show-current`, and the ahead/behind comparison inside `WT`. Preserve any intended implementation state and understand its relationship to the remote PR head before new edits.

Keep `WT` for the entire monitoring session. All installs, edits, conflict resolution, validation, commits, and pushes run with `cwd` set to `WT` or with an explicit `cd "$WT" && ...` in that tool call.

## Phase 3: Process the current state autonomously

1. Fetch the shared blocker inventory and authoritative current-head state. Read every unresolved thread, top-level review comment, latest review, and failed-check log.
2. Handle merge conflicts first, inside `WT`, using the repository's established base-update policy. Revalidate the complete result. Stop rather than guess if conflict resolution changes product behaviour or cannot be completed safely.
3. Classify feedback as `apply`, `discuss`, or `decline` under the shared protocol:
   - Apply correct, clear feedback by default.
   - Ask the reviewer a focused question when a genuine tradeoff or ambiguity remains.
   - Decline only with verified code- or requirement-based reasoning.
4. Diagnose failed checks from their logs. Fix code failures at their root. Rerun a job without code changes only when evidence shows a genuine infrastructure or test flake.
5. Group related code changes, run relevant validation in `WT`, and inspect the full diff.
6. Immediately before pushing, fetch the PR again and compare `headRefOid` with the expected remote head. If another commit landed, update `WT`, reconsider affected feedback, and rerun validation.
7. Commit logical changes and push normally to the actual PR head branch. Temporary local worktree branches use the explicit `HEAD:PR_HEAD_BRANCH` refspec. Never use force.
8. After the pushed commit is visible on GitHub, prepare concise human-facing replies, post them with the shared reply script, and resolve threads according to the shared bot/human matrix.
9. Re-fetch blockers and authoritative state for the new head. Require a clean intended `git status` after each successful push.

Do not ask the user to approve a routine remediation plan. Ask only when a decision is unsafe to make autonomously, such as contradictory product requirements, destructive data behaviour, or permission to perform a prohibited operation. Prohibited operations remain prohibited even if they would be convenient.

## Phase 4: Establish a race-safe watch baseline

The bundled watcher makes one blocking tool call and polls GitHub internally, conserving agent turns and tokens.

After a processing cycle, write a fresh canonical snapshot:

```bash
BASELINE="${TMPDIR:-/tmp}/babysit-pr-OWNER-REPO-PR_NUMBER.json"
TEMP_BASELINE="$(mktemp "${BASELINE}.tmp.XXXXXX")"
bash "$SKILL_DIR/scripts/wait-for-pr-change.sh" snapshot PR_NUMBER --repo OWNER/REPO > "$TEMP_BASELINE" || {
  status=$?
  rm -f "$TEMP_BASELINE"
  exit "$status"
}
jq -e 'type == "object" and has("repository") and has("pr") and has("reviewThreads")' "$TEMP_BASELINE" > /dev/null || {
  rm -f "$TEMP_BASELINE"
  exit 2
}
mv "$TEMP_BASELINE" "$BASELINE"
jq . "$BASELINE"
```

This sequence preserves the watcher exit status, validates the completed temporary file, and only then atomically replaces the baseline. Inspect the baseline file itself as the authoritative final state for the current cycle. If it contains a new failure, comment, review, head commit, or conflict, process that state before waiting. Do not take a separate final reading and then create the baseline, because a change in between could be missed.

Stop successfully when the snapshot proves either:

- `MERGED`: `mergedAt` is set or state is merged; or
- `READY TO MERGE`: every applicable criterion in the shared protocol holds for this exact head.

A PR that is green but still missing a required approval or requested review is not ready, not blocked, and not finished — it is waiting. Required reviews, pending re-reviews, and unanswered human threads are watched states: continue to Phase 5 so an approval, review, comment, or push wakes the agent, and give up only through the inactivity budget there.

Babysitting never performs the merge.

## Phase 5: Wait without agent polling

When the baseline has no actionable work but the PR is not yet ready — including when the only missing criterion is a required review or approval — run:

```bash
bash "$SKILL_DIR/scripts/wait-for-pr-change.sh" wait PR_NUMBER \
  --repo OWNER/REPO \
  --baseline "$BASELINE" \
  --interval 60 \
  --timeout "$MAX_WAIT_SECONDS"
```

`--timeout` is the inactivity budget: the maximum time to wait for anything at all to happen on the PR. It is not a cap on the whole babysitting session. Default `MAX_WAIT_SECONDS` to 3600 (one hour) unless the user's request sets a different bound. Each processed change starts the next wait fresh, so an active PR is monitored indefinitely while a silent one ends after one budget.

The script immediately compares GitHub with the baseline, so a change after baseline creation is not missed. It then blocks and polls internally. Parse its JSON result:

- `event: "changed"`: the baseline file has been atomically replaced with the new snapshot. Return to Phase 3 and process it; the next wait restarts the inactivity budget.
- `event: "timeout"`: nothing happened within the inactivity budget. Do not infer progress or readiness, and do not silently start another full wait. Take one fresh snapshot; if it reveals a change after all, process it and continue monitoring. If the PR state is genuinely unchanged, stop and report `TIMED OUT` as defined in Exit and cleanup.

If interrupted, report the exact current state and preserve `WT`. Do not replace this watcher with repeated agent `sleep` turns.

### Composition with yolo-ticket

When the explicitly invoked `yolo-ticket` skill is the caller, `READY TO MERGE`
returns control to that wrapper as an intermediate checkpoint rather than ending
the overall yolo run. `babysit-pr` still never invokes merge or auto-merge; the
yolo wrapper owns its separately authorised normal GitHub auto-merge request and
continues watching until GitHub reports `MERGED` or a precise terminal blocker.

## Exit and cleanup

Stop and report one of:

- `READY TO MERGE` with the PR URL and exact head SHA
- `MERGED` with the PR URL
- `CLOSED UNMERGED`
- `TIMED OUT` when the inactivity budget expired with the PR unchanged: report the budget that elapsed, the exact waiting state (for example "all checks green on HEAD_SHA, awaiting required human approval"), and the preserved worktree path so a later invocation can resume
- `BLOCKED` with the exact permission, authentication, unsafe decision, repeated failure, or no-progress reason
- `INTERRUPTED` with the preserved worktree path and current state

Waiting on reviewers is neither `BLOCKED` nor `READY TO MERGE`. A missing required approval, a requested re-review, or an unanswered human `discuss` thread is an expected waiting state: keep watching through Phase 5 and leave it only as `MERGED` or `READY TO MERGE` when the state resolves, or as `TIMED OUT` when the inactivity budget expires. Reserve `BLOCKED` for conditions babysitting can never progress, such as missing push access, persistent authentication failure, an unsafe decision, or the bounded no-progress limit.

Use a bounded policy: after roughly three cycles that repeat the same failure without new evidence or progress, stop as blocked rather than looping forever. Transient waiter/API failures are retried by the script; persistent failures are blockers.

Remove the managed worktree only when it is clean, all intended commits are confirmed pushed, and the `worktrees` skill says cleanup is safe. Never delete the PR head branch. Preserve a dirty or blocked worktree and report its path.

## Examples

### Babysit a PR with review feedback

User says: `Babysit PR 847 until it is ready.`

Adopt PR 847 into a managed worktree, apply valid comments, validate and push the fix, reply and resolve only after the push, then wait for new checks or reviews. Stop at `READY TO MERGE`; do not merge.

### Watch pending checks

User says: `Keep this PR moving.`

Process any current blockers. If only CI or review is pending, create and inspect the watcher baseline, then run the blocking waiter. A failed check wakes the agent for diagnosis; a passing final check may make the same head ready to merge.

### Awaiting a required human approval

Checks are green, every thread is resolved, but branch protection still requires a human review. This is a waiting state, not readiness and not a blocker: keep the watcher running so the approval, a new comment, or a push wakes the agent. Only when nothing at all happens on the PR for the full inactivity budget (default one hour), stop and report `TIMED OUT` with the exact pending state.

### Fork PR without push permission

The PR head belongs to a fork and authenticated push fails. Do not create a replacement branch in the base repository. Preserve any worktree state and report `BLOCKED: no push access to OWNER/FORK:BRANCH`.

## Common failures

- **Watcher reports invalid authentication:** verify `gh auth status` and repository access, then retry. Do not spin on persistent authentication errors.
- **Remote head changed before push:** fetch the new head, integrate it in `WT`, re-read affected feedback, revalidate, and retry a normal push.
- **Adoption returns the primary checkout:** create a managed temporary branch from the exact `headRefOid`; do not mutate the returned primary path.
- **A check repeatedly fails after a verified fix:** inspect the newest logs and stop after the bounded no-progress limit if no new root cause emerges.
- **Human discussion remains open:** leave a human `discuss` or `decline` thread unresolved and wait for a response; do not claim readiness.
