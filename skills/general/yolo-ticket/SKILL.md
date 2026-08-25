---
name: yolo-ticket
description: Explicit set-and-forget delivery for exactly one Linear ticket. Use only when the user directly invokes yolo-ticket, says "yolo this ticket", or explicitly requests autonomous ticket delivery through GitHub auto-merge. Runs start-ticket, babysits the PR to verified readiness, then enables normal repository-compatible auto-merge and watches until merged or precisely blocked. This exceptional merge authority never applies implicitly.
compatibility: Requires git, GitHub CLI, jq, linear-cli, network access, repository worktrees, and GitHub auto-merge permission.
disable-model-invocation: true
metadata:
  author: tvd
  version: 1.0.0
---

# YOLO Ticket

Use this skill only after a direct `yolo-ticket` invocation, “yolo this ticket”,
or an equally explicit request to take one named Linear ticket through normal
GitHub auto-merge without routine supervision. Require exactly one identifier
matching `^[A-Z][A-Z0-9]*-[0-9]+$`; normalise it to uppercase and reject flags,
URLs, partial matches, or multiple tickets.

That explicit invocation grants exceptional authority for this ticket's one PR:
implement it, babysit it to verified readiness, request normal GitHub auto-merge,
and continue until GitHub reports the merge. It does not grant authority to
bypass repository policy or perform a direct/manual merge.

## Non-negotiable rules

- Never use a direct merge fallback, `--admin`, a protection bypass, force-push,
  or a push to `main`.
- Never approve your own PR, dismiss reviews, change branch protection, change
  repository merge policy, reopen or retarget a PR, or redirect work to another
  branch.
- Do not enable auto-merge until `babysit-pr` proves `READY TO MERGE` for the
  exact current head under the shared readiness protocol.
- Enable auto-merge only for the exact PR created or resumed for this invocation's
  exact ticket.
- `start-ticket` and `babysit-pr` retain their one-writer, dedicated-worktree,
  current-head, validation, push-before-resolve, and scope rules.
- `babysit-pr` itself never invokes merge or auto-merge. This wrapper alone owns
  the explicit auto-merge request after readiness is established.
- Preserve a dirty or blocked worktree and report it. Never discard intended
  work to make automation convenient.

## Phase 1: Implement with start-ticket

1. Resolve this skill's loaded directory as `SKILL_DIR`.
2. Read `$SKILL_DIR/../start-ticket/SKILL.md` and execute it for the exact ticket
   identifier.
3. Reuse the same dedicated worktree, branch, and PR throughout the entire yolo
   run. Do not start a second implementation or create a competing PR.
4. Continue only after `start-ticket` reports `PR READY FOR REVIEW` and fresh
   evidence confirms:
   - the intended implementation is committed and pushed;
   - the PR is non-draft and targets the intended base;
   - the PR head SHA equals the validated local head;
   - the worktree has no uncommitted intended changes; and
   - no unsafe product, scope, permission, or repository ambiguity remains.

If `start-ticket` returns `BLOCKED`, stop with the same blocker. Do not weaken its
validation or worktree rules to reach the auto-merge phase.

## Phase 2: Identify the exact PR and merge policy

Fetch the PR and repository explicitly rather than relying on ambient branch
inference:

```bash
gh pr view PR_NUMBER --repo OWNER/REPO \
  --json number,url,state,isDraft,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest

gh api repos/OWNER/REPO \
  --jq '{allow_squash_merge,allow_rebase_merge,allow_merge_commit}'
```

Select exactly one merge method with this deterministic policy:

1. Follow an explicit merge method in authoritative repository instructions
   such as `AGENTS.md`, `CLAUDE.md`, or repository-owned contribution policy,
   but only if GitHub reports that method as allowed.
2. Otherwise, if exactly one method is allowed, use it.
3. Otherwise prefer allowed methods in this order: **squash**, then **rebase**,
   then **merge commit**.
4. If no method is allowed or repository instructions contradict GitHub state,
   stop `BLOCKED` rather than changing policy or guessing around the conflict.

Map the selected method to exactly one flag: `--squash`, `--rebase`, or `--merge`.
Never pass more than one method flag.

## Phase 3: Babysit to verified readiness

1. Read `$SKILL_DIR/../babysit-pr/SKILL.md` and follow its exact PR targeting,
   worktree reuse, shared readiness protocol, blocker inventory, feedback
   handling, conflict remediation, current-head verification, validation,
   commit/push, thread ordering, bounded no-progress, and blocking watcher rules.
2. Keep the original ticket worktree as the only writer. For every push, obey
   `babysit-pr`'s remote-head race check and revalidate the changed surface.
3. Do not enable auto-merge while checks, required reviews, actionable comments,
   unresolved threads, conflicts, or any other shared readiness blocker remains.
4. `READY TO MERGE` from `babysit-pr` is an intermediate checkpoint for this
   wrapper, not completion. Record the exact ready head SHA and immediately
   re-fetch authoritative PR state before continuing.

If another actor already merged the PR, report `MERGED`. If the PR is closed
without merging, report `CLOSED UNMERGED`. Propagate precise `BLOCKED` or
`INTERRUPTED` outcomes without weakening babysit safeguards.

## Phase 4: Enable auto-merge at the ready head

Re-fetch the PR and blocker inventory. Require that the head still equals the
exact head proven `READY TO MERGE` and that every shared readiness criterion
still holds. Record that SHA as `READY_HEAD`.

Before enabling auto-merge, verify that repository protections or merge-queue
rules require a newly pushed head to satisfy fresh checks or equivalent policy
before merging. The watcher is not an atomic protection against a later push. If
that safety property cannot be established from repository/ruleset state, stop
`BLOCKED` instead of enabling auto-merge.

Bind the request atomically to the proven-ready head and use exactly one selected
method:

```bash
gh pr merge PR_NUMBER --repo OWNER/REPO --auto METHOD_FLAG \
  --match-head-commit "$READY_HEAD"
```

For example, when squash is selected, `METHOD_FLAG` is `--squash`. Do not add
`--admin` and do not retry without `--auto`. If the command reports a head
mismatch, re-fetch the new head and return to Phase 3 without enabling
anything. If auto-merge is disabled for the repository, unavailable for the PR,
rejected by policy, or forbidden to the authenticated user, stop with the exact
command, stderr/API response, and classified cause:

```text
BLOCKED: normal GitHub auto-merge could not be enabled for OWNER/REPO#PR_NUMBER
```

Never fall back to an immediate/manual merge or GraphQL mutation that bypasses
the repository's normal auto-merge feature. GitHub may merge immediately when
all requirements already hold; that result is authorised by the explicit yolo
invocation.

Read back authoritative state and require either `state == MERGED` or a non-null
`autoMergeRequest` for the same `READY_HEAD`:

```bash
gh pr view PR_NUMBER --repo OWNER/REPO \
  --json state,headRefOid,autoMergeRequest,mergeStateStatus,reviewDecision,statusCheckRollup
```

If it is already merged, report `MERGED`. If the readback head differs from
`READY_HEAD` and auto-merge is present, immediately disable auto-merge, verify
`autoMergeRequest` is null, and return to Phase 3. Never leave auto-merge active
on a head that was not the one proven ready. Otherwise continue.

## Phase 5: Watch auto-merge to completion

Build and inspect a canonical snapshot, then use the sibling blocking watcher:

```bash
BASELINE="${TMPDIR:-/tmp}/yolo-ticket-OWNER-REPO-PR_NUMBER.json"
TEMP_BASELINE="$(mktemp "${BASELINE}.tmp.XXXXXX")"
bash "$SKILL_DIR/../babysit-pr/scripts/wait-for-pr-change.sh" snapshot PR_NUMBER \
  --repo OWNER/REPO > "$TEMP_BASELINE" || {
    status=$?
    rm -f "$TEMP_BASELINE"
    exit "$status"
  }
jq -e 'type == "object" and has("repository") and has("pr") and has("reviewThreads")' \
  "$TEMP_BASELINE" >/dev/null || {
    rm -f "$TEMP_BASELINE"
    exit 2
  }
mv "$TEMP_BASELINE" "$BASELINE"
jq . "$BASELINE"
bash "$SKILL_DIR/../babysit-pr/scripts/wait-for-pr-change.sh" wait PR_NUMBER \
  --repo OWNER/REPO --baseline "$BASELINE" --interval 60 --timeout 3600
```

For each changed snapshot, re-fetch authoritative PR state with `gh pr view`
before acting; the canonical snapshot includes `autoMergeRequest`, but decisions
must use a fresh current-head read:

1. If GitHub reports `MERGED`, finish successfully.
2. If the PR is closed without merging, report `CLOSED UNMERGED`.
3. If the head changed or any shared readiness criterion no longer holds,
   disable auto-merge before remediation:

   ```bash
   gh pr merge PR_NUMBER --repo OWNER/REPO --disable-auto
   ```

   Confirm `autoMergeRequest` is null, return to Phase 3, babysit the new state
   to `READY TO MERGE`, and only then enable auto-merge again for that exact
   validated head.
4. If auto-merge disappeared while the same head remains ready, re-check the
   repository method and permissions, then re-enable it once. Repeated loss of
   auto-merge without explanation is a blocker, not a reason to loop.
5. A timeout is not progress. Take a fresh snapshot and continue only while the
   bounded policy remains useful.

Do not busy-poll with agent turns. After roughly three cycles that repeat the
same failure or cannot preserve auto-merge without new evidence, stop `BLOCKED`
instead of looping forever.

## Exit states

Completion is one of:

- `MERGED` — exact ticket, PR URL, final head, merge commit when available,
  selected method, and validation/remediation summary;
- `BLOCKED` — exact permission, policy, unsafe decision, repeated failure, or
  no-progress reason, plus preserved worktree and PR state;
- `CLOSED UNMERGED` — record the exact terminal PR state and do not reopen it;
- `INTERRUPTED` — report the preserved worktree, branch, PR, head, auto-merge
  state, and next safe action.

Never finish yolo-ticket merely because the PR is `READY TO MERGE`.
