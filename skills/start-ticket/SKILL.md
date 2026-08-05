---
name: start-ticket
description: Executes a Linear ticket end-to-end from investigation through an isolated implementation, validation, review, pull request, and review-feedback handling. Use only when the user explicitly invokes start-ticket with an issue identifier such as LLE-1234 or explicitly asks to start a ticket through the complete delivery workflow.
compatibility: Requires git, GitHub CLI, jq, linear-cli, network access, and a repository with an origin remote.
disable-model-invocation: true
metadata:
  author: tvd
  version: 1.0.0
---

# Start Ticket

Take one Linear ticket from intake to a pull request that is ready to merge, or to a precise external blocker. This is an autonomous delivery command: after requirements are clear, proceed without asking for routine approval.

## Non-negotiable rules

- Require exactly one ticket identifier matching `^[A-Z][A-Z0-9]*-[0-9]+$`. Normalise it to uppercase. Reject flags, URLs, partial matches, and multiple tickets.
- Use one writer. Do not let multiple agents edit the same checkout or branch.
- Do not launch a workflow merely for confidence. A ticket is sequential by default.
- Never edit the user's main checkout. Work only in a clean, dedicated worktree for this ticket.
- Branch from freshly fetched `origin/main`, not stale local `main` and not the current feature branch.
- Never merge the pull request, force-push, or push to `main`.
- Keep scope limited to the ticket. Ask before unrelated cleanup or materially expanded scope.
- Do not stop with intended changes uncommitted, unpushed, or lacking a pull request unless there is a concrete blocker.

## Harness portability

Use capabilities rather than assuming a particular agent product.

- If the current session is already in the correct clean ticket worktree, reuse it.
- If native worktree isolation can move this session safely before edits, use it.
- Otherwise, prefer available `worktree_list` and `worktree_new` tools.
- If those tools do not exist, use standard `git worktree` commands.
- Record the absolute worktree path as `WT`. Every subsequent command and file operation must target `WT`. Do not assume a `cd` persists between tool calls.

Delegation is optional:

- Ordinary tickets: investigate, implement, validate, and review directly.
- Broad investigation: at most one or a small bounded set of read-only explorers when that materially reduces context or latency.
- Broad or high-risk final diff: optionally use one independent read-only reviewer.
- Never use a workflow or several reviewers for a routine confidence check.
- If an isolated child becomes the writer, it is the sole writer and owns implementation through push and PR creation.

## Phase 1: Load and start the ticket

1. Resolve this skill's directory from the loaded `SKILL.md` path and call it `SKILL_DIR`.
2. Fetch the ticket with the bundled exact-identifier helper:

   ```bash
   bash "$SKILL_DIR/scripts/get-ticket.sh" LLE-1234
   ```

   The helper retries uncached direct lookup and falls back to an exact team-key and issue-number GraphQL query. Read the title, description, comments, acceptance criteria, branch name, state, priority, assignee, and URL.

3. If the `linear-cli` skill is available, load it and follow its media-retrieval guidance. Inspect every screenshot, recording, transcript, and relevant attachment in the description and comments. Do not infer visual behaviour from filenames.
4. Assign the issue to yourself and move it to **In Progress**:

   ```bash
   linear-cli issues start LLE-1234 --output json --compact --no-pager --quiet
   ```

   If `issues start` is unavailable, use `issues assign LLE-1234 --assignee me` and `issues update LLE-1234 -s "In Progress"` with the standard JSON/no-pager flags. Verify both fields with a fresh `issues get` call.

5. If ticket retrieval or the state update fails after transient retries, stop and report the exact command and error. Do not begin code changes against incomplete ticket context.

## Phase 2: Investigate before creating code

1. Read repository instructions such as `AGENTS.md` and `CLAUDE.md` from the repository root through the relevant subtree.
2. Search for the reported behaviour, affected components, comparable implementations, tests, and recent related changes.
3. Reproduce or trace the current behaviour far enough to identify the root cause. For frontend reports, inspect supplied media and use browser-assisted testing when practical.
4. Decide whether a code or documentation change is actually required.

If no change is warranted:

- Do not create an empty branch or pull request.
- Report the evidence, explain why the existing behaviour satisfies the ticket or why the issue cannot be reproduced, and identify any product decision still needed.
- Leave the ticket In Progress unless the user explicitly asks for another state.

If requirements are materially ambiguous, ask one focused question before implementation. Otherwise write a concise implementation plan and continue automatically.

## Phase 3: Create or reuse the ticket worktree

1. Determine the repository root and inspect all existing worktrees before creating one:

   ```bash
   git worktree list --porcelain
   git fetch origin main
   ```

2. Reuse an existing clean worktree when its branch or open PR clearly belongs to this ticket. If an existing ticket worktree is dirty, inspect it and continue there rather than creating a competing checkout. Never discard its work.
3. Prefer the ticket's Linear branch name. Otherwise use the repository's established prefix and a branch containing the ticket identifier and a short slug.
4. Create a new worktree from exactly `origin/main`. With raw git, use the equivalent of:

   ```bash
   git worktree add -b BRANCH ABSOLUTE_WORKTREE_PATH origin/main
   ```

5. Run repository-configured worktree setup hooks or copy explicitly configured ignored files when required. Do not copy arbitrary secrets or the main checkout's uncommitted changes.
6. Before editing, verify inside `WT`:

   ```bash
   git status --porcelain
   git branch --show-current
   ```

   For a newly created branch, also verify that `git rev-parse HEAD` exactly equals `git rev-parse origin/main`. For a resumed ticket branch, preserve its commits and uncommitted work; verify that it was originally based on `main`, inspect its divergence from `origin/main`, and update it according to repository policy when needed without force-pushing.

## Phase 4: Plan and implement

1. Turn the investigation into a short todo list covering implementation and validation.
2. Make the smallest complete change that satisfies the ticket and acceptance criteria.
3. Follow repository conventions and reuse existing patterns only after verifying they are correct for this case.
4. Add or update tests for meaningful success, failure, and regression paths. Avoid tests that only assert implementation details.
5. Keep every read, edit, and command anchored to `WT` by using an explicit working-directory option, absolute paths, or `cd "$WT" && ...` in each shell call.
6. Re-check scope against the ticket before validation.

## Phase 5: Validate and review

1. Run targeted tests first, then the relevant type-check, lint, build, integration, or end-to-end checks required by the changed surface.
2. Inspect `git diff --check`, `git status --short`, the full diff against `origin/main`, and the commit range.
3. Review for correctness, security, data integrity, error handling, test quality, responsive behaviour where applicable, and ticket compliance.
4. Fix verified findings and rerun affected checks.
5. Use one independent read-only reviewer only when the change is broad, high-risk, or changes a public/persisted contract. The main agent remains responsible for verifying and applying findings.
6. When the sibling `pr-review` skill is installed and the change meets that high-risk bar, read `$SKILL_DIR/../pr-review/SKILL.md` and run its local-branch review once without posting to GitHub. Do not invoke the full multi-agent review for routine tickets or repeat it merely for confidence.

Do not manufacture work to justify a review. A clean direct review is sufficient for a routine ticket.

## Phase 6: Commit, push, and open the PR

1. Ensure only intended files are changed.
2. Commit logical changes with a concise message that includes or clearly corresponds to the ticket.
3. Push only the ticket branch with upstream tracking.
4. Create a ready-for-review, non-draft pull request targeting `main`. Use a temporary Markdown file and `gh pr create --body-file`; never encode multiline Markdown as escaped newlines in `--body`.
5. The PR title should identify the ticket and change. The body must include:
   - ticket link
   - summary
   - implementation details and key decisions
   - validation commands and results
   - risks or caveats
   - screenshots or recordings for visible UI changes
6. Immediately read the PR body back with `gh pr view` and fix malformed formatting.
7. Verify the branch is pushed and the worktree has no uncommitted changes.

If a PR already exists for the ticket branch, update it instead of opening a duplicate.

## Phase 7: Drive feedback to merge readiness

Read the canonical protocol at `$SKILL_DIR/../_shared/pr-readiness/PROTOCOL.md` and follow it exactly. Before posting any PR reply or top-level comment, read `$SKILL_DIR/../writing-for-humans/SKILL.md` and apply its send-ready process to the final draft. Use the shared readiness scripts:

```bash
bash "$SKILL_DIR/../_shared/pr-readiness/scripts/fetch-pr-blockers.sh" PR_NUMBER
bash "$SKILL_DIR/../_shared/pr-readiness/scripts/reply-and-resolve.sh" PR_NUMBER THREAD_ID COMMENT_DATABASE_ID "REPLY" [--no-resolve]
```

This skill's control policy is **autonomous and bounded**:

- Apply valid feedback, fix failing checks, commit, push, and handle threads without asking for routine approval.
- Keep the ticket worktree as the only writer and preserve the protocol's push-before-resolve ordering.
- Re-check authoritative state for every new head.
- Never merge or force-push.
- Do not busy-poll. Use a harness-native park, background, watch, or scheduled-resume mechanism when available, with at least 60 seconds between remote checks.
- If only external CI or human review is pending and no resumable wait exists, report the exact pending state and stop cleanly. A later `/start-ticket` invocation must detect and resume the existing branch, worktree, and PR.
- After roughly three cycles with no real progress, stop and report the blocker instead of looping forever.

Declare `READY TO MERGE` only when every applicable criterion in the shared protocol is satisfied for the current head.

## Completion report

Return:

- ticket identifier and title
- worktree path and branch
- concise implementation summary
- validation commands and outcomes
- review outcome and any remaining external wait
- pull request URL
- explicit final state: `READY TO MERGE` or `BLOCKED` with the exact blocker
