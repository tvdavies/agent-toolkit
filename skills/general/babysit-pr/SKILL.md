---
name: babysit-pr
description: Autonomously monitors a GitHub pull request and keeps it moving toward merge readiness. Use only when the user explicitly asks to "babysit PR", "watch this PR", "monitor this PR", "keep this PR moving", "address PR feedback", "handle review comments", "fix PR feedback", "make this PR mergeable", or "unblock this PR" for a named PR or the unambiguous current PR. Handles reviews, comments, checks, flakes, and conflicts; may commit and push fixes to the PR head branch, but never merges.
compatibility: Requires git, GitHub CLI, jq, network access, and a repository with worktree support.
disable-model-invocation: true
metadata:
  author: tvd
  version: 1.0.0
---

# Babysit PR

Use this skill only after the user explicitly asks to babysit, watch, monitor, address feedback on, make mergeable, or unblock a named PR or the unambiguous current PR. That explicit invocation authorises routine remediation for this PR: inspect feedback and logs, edit code in an isolated worktree, validate, commit, push to the PR head branch, reply to reviewers, resolve handled threads, and rerun verified flakes. Work autonomously until the PR is ready to merge, already merged, or precisely blocked; do not present a plan or pause for routine confirmation.

## Non-negotiable rules

- Never merge the pull request.
- Never force-push, push to a protected branch, or redirect work to a different branch because the intended head is unavailable.
- Never run dependency installation, formatting, builds, tests, code generation, edits, commits, or conflict resolution in the primary checkout. Those commands belong in a dedicated managed worktree.
- Read-only discovery may happen in the primary checkout before isolation. After selecting the worktree, keep every code-related command anchored to its absolute path.
- Re-fetch the remote PR head SHA immediately before every push. If it moved, integrate the new head safely and revalidate before pushing.
- Keep one writer and the same worktree across monitoring cycles. Do not discard dirty work or create competing worktrees.
- Resolve a review thread only after the corresponding pushed commit exists.
- Stop on unsafe ambiguity, unavailable push permission, repeated no-progress, or an operation that would require violating these rules.

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

Require one explicit PR number or URL, or derive the PR only when the current branch unambiguously has one. Record the repository explicitly so later `gh` calls do not depend on the current directory.

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

## Phase 2: Establish a dedicated worktree

Do this before any code-related command, even when the PR branch is already checked out somewhere.

1. Use `worktree_list` first. Reuse an existing worktree only when it belongs to this PR, is outside the primary checkout, and is under the configured managed worktree root.
2. Otherwise call `worktree_adopt` with the PR number and repository.
3. Verify the returned absolute path against `git worktree list --porcelain` and the managed worktree root. The current adoption helper may return the primary checkout when the PR branch is already checked out there. Detect that before running any mutating command.
4. If adoption returned the primary checkout, do not use it. Ensure the exact PR head object exists locally without changing primary-checkout files. If necessary, fetch the GitHub PR head ref with the equivalent of `git fetch origin pull/PR_NUMBER/head`, verify `FETCH_HEAD` equals the recorded `headRefOid`, and restart discovery if it moved. Then call `worktree_new` with a unique name such as `babysit-pr-PR_NUMBER` and `base` set to that exact `headRefOid`. This creates a temporary local branch at the PR head. Record that pushes must use an explicit refspec:

   ```bash
   git push HEAD:PR_HEAD_BRANCH
   ```

5. For a fork PR, configure or select a remote for the actual head repository. Verify authenticated push access before editing. If the head repository cannot be pushed, stop with `BLOCKED: no push access to HEAD_REPOSITORY`; do not push the work to the base repository or another branch.
6. Record the absolute path as `WT`. Run `git status --porcelain`, `git rev-parse HEAD`, and `git branch --show-current` inside `WT`. Before new work, the intended tree must be clean and its HEAD must equal the recorded PR head, unless it contains preserved work from an earlier babysitting cycle that must be continued rather than discarded.

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

Babysitting never performs the merge.

## Phase 5: Wait without agent polling

When the baseline has no actionable work but the PR is not yet ready, run:

```bash
bash "$SKILL_DIR/scripts/wait-for-pr-change.sh" wait PR_NUMBER \
  --repo OWNER/REPO \
  --baseline "$BASELINE" \
  --interval 60 \
  --timeout 3600
```

The script immediately compares GitHub with the baseline, so a change after baseline creation is not missed. It then blocks and polls internally. Parse its JSON result:

- `event: "changed"`: the baseline file has been atomically replaced with the new snapshot. Return to Phase 3 and process it.
- `event: "timeout"`: do not infer progress or readiness. Inspect a new snapshot, process anything actionable, then wait again if continued monitoring is still useful.

If interrupted, report the exact current state and preserve `WT`. Do not replace this watcher with repeated agent `sleep` turns.

## Exit and cleanup

Stop and report one of:

- `READY TO MERGE` with the PR URL and exact head SHA
- `MERGED` with the PR URL
- `CLOSED UNMERGED`
- `BLOCKED` with the exact permission, authentication, unsafe decision, repeated failure, or no-progress reason
- `INTERRUPTED` with the preserved worktree path and current state

Use a bounded policy: after roughly three cycles that repeat the same failure without new evidence or progress, stop as blocked rather than looping forever. Transient waiter/API failures are retried by the script; persistent failures are blockers.

Remove the managed worktree only when it is clean, all intended commits are confirmed pushed, and the `worktrees` skill says cleanup is safe. Never delete the PR head branch. Preserve a dirty or blocked worktree and report its path.

## Examples

### Babysit a PR with review feedback

User says: `Babysit PR 847 until it is ready.`

Adopt PR 847 into a managed worktree, apply valid comments, validate and push the fix, reply and resolve only after the push, then wait for new checks or reviews. Stop at `READY TO MERGE`; do not merge.

### Watch pending checks

User says: `Keep this PR moving.`

Process any current blockers. If only CI or review is pending, create and inspect the watcher baseline, then run the blocking waiter. A failed check wakes the agent for diagnosis; a passing final check may make the same head ready to merge.

### Fork PR without push permission

The PR head belongs to a fork and authenticated push fails. Do not create a replacement branch in the base repository. Preserve any worktree state and report `BLOCKED: no push access to OWNER/FORK:BRANCH`.

## Common failures

- **Watcher reports invalid authentication:** verify `gh auth status` and repository access, then retry. Do not spin on persistent authentication errors.
- **Remote head changed before push:** fetch the new head, integrate it in `WT`, re-read affected feedback, revalidate, and retry a normal push.
- **Adoption returns the primary checkout:** create a managed temporary branch from the exact `headRefOid`; do not mutate the returned primary path.
- **A check repeatedly fails after a verified fix:** inspect the newest logs and stop after the bounded no-progress limit if no new root cause emerges.
- **Human discussion remains open:** leave a human `discuss` or `decline` thread unresolved and wait for a response; do not claim readiness.
