---
name: start-ticket
description: Executes one Linear ticket from investigation through isolated implementation, validation, implementation self-review, and a clean non-draft pull request ready for external review. Use only when the user explicitly invokes start-ticket with an issue identifier such as TEAM-123 or explicitly asks to start that ticket. Stops before remote CI monitoring or GitHub review-feedback handling.
compatibility: Requires git, GitHub CLI, jq, linear-cli, network access, and a repository with an origin remote.
disable-model-invocation: true
metadata:
  author: tvd
  version: 1.0.0
---

# Start Ticket

Take one Linear ticket from intake to a clean, pushed, non-draft pull request
ready for external review, or to a precise blocker. This is an autonomous
implementation command: after requirements are clear, proceed without asking
for routine approval.

This skill ends when the implementation PR is ready for reviewers. Do not
monitor remote CI, process GitHub review feedback, comments, or review threads,
wait for approval, or claim the PR is ready to merge. Those responsibilities
belong to `babysit-pr` when the user invokes it separately.

## Non-negotiable rules

- Outside Dispatch, require exactly one ticket identifier matching
  `^[A-Z][A-Z0-9]*-[0-9]+$`. Normalise it to uppercase. Reject flags, URLs,
  partial matches, and multiple tickets.
- Use one writer. Do not let multiple agents edit the same checkout or branch.
- Do not launch a workflow merely for confidence. A ticket is sequential by
  default.
- Never edit the user's main checkout. Work only in a clean, dedicated worktree
  for this ticket.
- Branch from freshly fetched `origin/main`, not stale local `main` and not the
  current feature branch.
- Never merge the pull request, force-push, or push to `main`.
- Keep scope limited to the ticket. Ask before unrelated cleanup or materially
  expanded scope.
- Do not stop with intended changes uncommitted, unpushed, or lacking a pull
  request unless there is a concrete blocker.

## Dispatch integration

When `DISPATCH_TASK_ID` is set and the named task is in `implement`, that Docket
wake is the explicit invocation. Apply these integration rules while keeping all
implementation, validation, self-review, push, and no-merge rules below:

1. Resolve `SKILL_DIR`. When
   `$SKILL_DIR/../_shared/docket-stage/PROTOCOL.md` exists, read and follow it.
2. Read the complete Docket task, activity, comments, attachments,
   relationships, references, optional approved plan, and authoritative source
   ticket before acting. A Docket plan is optional when the combined context is
   sufficiently bounded and verifiable.
3. If the task references a Linear ticket, retain this skill's exact identifier
   lookup, media retrieval, assignment, and In Progress transition. A genuinely
   non-Linear or non-repository Docket task may use its authoritative Docket
   context instead of inventing a Linear identifier.
4. Classify the deliverable as repository-backed or non-repository. Before
   repository edits, resolve and verify exactly one `project:<key>` label whose
   key exists in Dispatch configuration. A non-repository task needs no project
   label.
5. Dispatch already provisioned or reused the authoritative task worktree as
   the current process directory. Verify the cwd, branch, worktree registration,
   task `worktree` reference, status, and relationship to any existing PR.
   Never create or adopt another worktree. Preserve intended dirty or ahead work
   on retries and understand it before editing.
6. For repository completion, create or update one non-draft ready-for-review
   PR, add or reuse its canonical Docket `pr` reference, and record the branch,
   worktree, exact head SHA, requirements-to-code/tests/evidence coverage,
   validation commands/results, implementation self-review, risks, and PR URL.
   Then move exactly once to `review`.
7. For a non-repository task, skip repository worktree creation and PR phases.
   Implement against only the explicitly named target, verify the requested
   observable result, record durable evidence, and move exactly once to `done`.
   Do not invent a repository or PR.
8. Material scope ambiguity becomes a `scope_decision` wait. Record external
   blockers durably with the exact command, evidence, and safe current state.
   Never merge, force-push, or push to `main`.

## Harness portability

Use capabilities rather than assuming a particular agent product.

- If the current session is already in the correct clean ticket worktree, reuse
  it.
- If native worktree isolation can move this session safely before edits, use
  it.
- Otherwise, prefer available `worktree_list` and `worktree_new` tools.
- If those tools do not exist, use standard `git worktree` commands.
- For repository-backed work, record the absolute worktree path as `WT`. Every
  subsequent repository command and file operation must target `WT`. Do not
  assume a `cd` persists between tool calls.
- In Dispatch, the integration section supersedes worktree creation: reuse the
  already-provisioned current worktree.

Delegation is optional:

- Ordinary tickets: investigate, implement, validate, and self-review directly.
- Broad investigation: at most one or a small bounded set of read-only
  explorers when that materially reduces context or latency.
- Broad or high-risk final diff: optionally use one independent read-only
  reviewer.
- Never use a workflow or several reviewers for a routine confidence check.
- If an isolated child becomes the writer, it is the sole writer and owns
  implementation through push and PR creation.

## Phase 1: Load and start the ticket

Outside Dispatch, resolve exactly one ticket identifier before proceeding. In
Dispatch, use an exact referenced Linear identifier when present; otherwise use
the authoritative Docket context as described above.

1. Resolve this skill's directory from the loaded `SKILL.md` path and call it
   `SKILL_DIR`.
2. For a Linear-backed task, fetch the ticket with the bundled exact-identifier
   helper:

   ```bash
   bash "$SKILL_DIR/scripts/get-ticket.sh" TEAM-123
   ```

   The helper retries uncached direct lookup and falls back to an exact team-key
   and issue-number GraphQL query. Read the title, description, comments,
   acceptance criteria, branch name, state, priority, assignee, and URL.
3. If the `linear-cli` skill is available, load it and follow its media-retrieval
   guidance. Inspect every screenshot, recording, transcript, and relevant
   attachment in the description and comments. Do not infer visual behaviour
   from filenames.
4. Assign the Linear issue to yourself and move it to **In Progress**:

   ```bash
   linear-cli issues start TEAM-123 --output json --compact --no-pager --quiet
   ```

   If `issues start` is unavailable, use `issues assign TEAM-123 --assignee me`
   and `issues update TEAM-123 -s "In Progress"` with the standard
   JSON/no-pager flags. Verify both fields with a fresh `issues get` call.
5. If required ticket retrieval or the state update fails after transient
   retries, stop and report the exact command and error. Do not begin code
   changes against incomplete authoritative context.

## Phase 2: Investigate before creating code

1. Read repository instructions such as `AGENTS.md` and `CLAUDE.md` from the
   repository root through the relevant subtree.
2. Search for the reported behaviour, affected components, comparable
   implementations, tests, and recent related changes.
3. Reproduce or trace the current behaviour far enough to identify the root
   cause. For frontend reports, inspect supplied media and use browser-assisted
   testing when practical.
4. Decide whether a code or documentation change is actually required.

If no change is warranted:

- Do not create an empty branch or pull request.
- Report the evidence, explain why the existing behaviour satisfies the ticket
  or why the issue cannot be reproduced, and identify any product decision
  still needed.
- Leave a Linear ticket In Progress unless the user explicitly asks for another
  state. In Dispatch, record the evidence and use the Docket integration's
  appropriate terminal or decision path.

If requirements are materially ambiguous, ask one focused question or set the
Dispatch `scope_decision` wait before implementation. Otherwise write a concise
implementation plan and continue automatically.

## Phase 3: Create or reuse the ticket worktree

Skip worktree creation in Dispatch and verify/reuse its current task worktree.
Otherwise:

1. Determine the repository root and inspect all existing worktrees before
   creating one:

   ```bash
   git worktree list --porcelain
   git fetch origin main
   ```

2. Reuse an existing clean worktree when its branch or open PR clearly belongs
   to this ticket. If an existing ticket worktree is dirty, inspect it and
   continue there rather than creating a competing checkout. Never discard its
   work.
3. Prefer the ticket's Linear branch name. Otherwise use the repository's
   established prefix and a branch containing the ticket identifier and a short
   slug.
4. Create a new worktree from exactly `origin/main`. With raw git, use the
   equivalent of:

   ```bash
   git worktree add -b BRANCH ABSOLUTE_WORKTREE_PATH origin/main
   ```

5. Run repository-configured worktree setup hooks or copy explicitly configured
   ignored files when required. Do not copy arbitrary secrets or the main
   checkout's uncommitted changes.
6. Before editing, verify inside `WT`:

   ```bash
   git status --porcelain
   git branch --show-current
   ```

   For a newly created branch, also verify that `git rev-parse HEAD` exactly
   equals `git rev-parse origin/main`. For a resumed ticket branch, preserve its
   commits and uncommitted work; verify that it was originally based on `main`,
   inspect its divergence from `origin/main`, and update it according to
   repository policy when needed without force-pushing.

## Phase 4: Plan and implement

1. Turn the investigation into a short todo list covering implementation and
   validation.
2. Make the smallest complete change that satisfies the ticket and acceptance
   criteria.
3. Follow repository conventions and reuse existing patterns only after
   verifying they are correct for this case.
4. Add or update tests for meaningful success, failure, and regression paths.
   Avoid tests that only assert implementation details.
5. For repository-backed work, keep every read, edit, and command anchored to
   `WT` by using an explicit working-directory option, absolute paths, or
   `cd "$WT" && ...` in each shell call. For non-repository Dispatch work,
   anchor operations to only the explicitly named target.
6. Re-check scope against the ticket before validation.

## Phase 5: Validate and implementation self-review

1. Build an explicit requirements-to-code/tests/evidence coverage map.
2. Run targeted tests first, then the relevant type-check, lint, build,
   integration, or end-to-end checks required by the changed surface.
3. Inspect `git diff --check`, `git status --short`, the full diff against
   `origin/main`, and the commit range.
4. Self-review for correctness, security, data integrity, error handling, test
   quality, responsive behaviour where applicable, and ticket compliance.
5. Fix verified findings and rerun affected checks.
6. For broad, high-risk, security-sensitive, migration, or public/persisted
   contract changes, optionally ask one independent read-only reviewer to inspect
   only the local diff, repository files, requirements, and local validation
   evidence. Explicitly forbid that reviewer from calling GitHub, discovering an
   associated PR, reading remote checks, or fetching PR conversation. The main
   agent remains responsible for verifying and applying findings.
7. Do not invoke the `pr-review` skill from `start-ticket`: its broader PR mode
   may discover an existing PR and read remote review or CI state. Use the
   bounded local-only review above instead.

Do not manufacture work to justify a review. A clean direct self-review is
sufficient for a routine ticket. This phase does not inspect or respond to
remote GitHub checks, review feedback, comments, or threads.

## Phase 6: Commit, push, and open the PR

1. Ensure only intended files are changed.
2. Commit logical changes with a concise message that includes or clearly
   corresponds to the ticket.
3. Push only the ticket branch with upstream tracking.
4. Create a ready-for-review, non-draft pull request targeting `main`. Use a
   temporary Markdown file and `gh pr create --body-file`; never encode
   multiline Markdown as escaped newlines in `--body`.
5. The PR title should identify the ticket and change. The body must include:
   - ticket link when applicable
   - summary
   - implementation details and key decisions
   - validation commands and results
   - risks or caveats
   - screenshots or recordings for visible UI changes
6. Immediately read the PR body back with `gh pr view` and fix malformed
   formatting.
7. Verify the branch is pushed, record the exact remote head SHA, and ensure the
   worktree has no uncommitted intended changes.

If a PR already exists for the ticket branch, update it and mark it ready when
necessary instead of opening a duplicate. Do not inspect remote checks or review
feedback after the ready-for-review PR and current head are verified.

Apply the Dispatch integration's Docket reference, evidence, and stage transition
only after this phase succeeds.

## Completion report

Return:

- ticket identifier and title, or authoritative Docket task for a non-Linear
  Dispatch invocation
- worktree path and branch
- concise implementation summary and requirements coverage
- exact validation commands and outcomes
- implementation self-review outcome
- pull request URL and exact head SHA, when repository-backed
- explicit final state: `PR READY FOR REVIEW`, verified non-repository `DONE`, or
  `BLOCKED` with the exact blocker

Never report `READY TO MERGE` from this skill.
