---
name: pr-review
description: Comprehensive PR review using parallel sub-agents for standards compliance, security, architecture, test coverage, ticket compliance, and build validation. Use when user says "review this PR", "review my changes", "check my PR", "pr review", "code review", "review the branch", "check before merge", "are my changes ready", or invokes /pr-review. Supports conversational output and GitHub PR comments.
metadata:
  author: tvd
  version: 1.0.0
---

# PR Review

Multi-agent pull request review that analyses code changes across six dimensions in parallel, then synthesises findings into a prioritised report. Designed for thorough, high-confidence reviews that surface real issues without manufacturing noise.

## Arguments

- `--since COMMIT_SHA`: Narrow the diff to `COMMIT_SHA...HEAD` for incremental re-review
- `--post`: Post the review as a GitHub PR comment instead of conversational output
- `--base BRANCH_NAME`: Override the detected base branch
- `--headless`: Non-interactive mode for CI/automation (see Headless Mode section)
- `--pr NUMBER`: Review a specific PR by number instead of detecting from the current branch. The checkout must already be at the PR `headRefOid`; use the exact `baseRefOid...headRefOid` diff range and pass `--pr NUMBER` to `post-review.sh`.

## Working Directory

**Stay in the current working directory for the entire review.** Do not `cd` to the repository root or any other directory. If running inside a git worktree, all git commands, file reads, and sub-agent dispatches must operate within that worktree. When launching sub-agents, explicitly tell each sub-agent to work within the current directory and not change to another location.

For `--pr NUMBER` reviews, the current working directory must already be the exact PR worktree. Do not search the filesystem for another checkout if git commands fail. In headless mode, fail cleanly rather than reviewing from a guessed repository.

## Review Temporary Directory

All generated review artifacts MUST be written under the per-review temporary directory:

```bash
REVIEW_TMPDIR="${PR_REVIEW_TMPDIR:-${TMPDIR:-/tmp}}"
mkdir -p "$REVIEW_TMPDIR"
```

Use these paths instead of global `/tmp` paths:

- `$REVIEW_TMPDIR/pr-review.md`
- `$REVIEW_TMPDIR/pr-review-inline.json`
- `$REVIEW_TMPDIR/pr-prior-discussion.md`
- `$REVIEW_TMPDIR/pr.diff`

This prevents concurrent headless reviews from overwriting each other's body, inline-comment, diff, or prior-discussion files.

## Phase 1: Context Gathering

Run these steps sequentially before dispatching sub-agents.

### 1.0 PR Context Preflight

When reviewing with `--pr NUMBER`, validate the checkout before reading files or posting anything:

```bash
git rev-parse --show-toplevel
REVIEW_TMPDIR="${PR_REVIEW_TMPDIR:-${TMPDIR:-/tmp}}"
mkdir -p "$REVIEW_TMPDIR"
PR_META=$(gh pr view PR_NUMBER --json number,baseRefName,baseRefOid,headRefName,headRefOid)
HEAD_OID=$(printf '%s' "$PR_META" | jq -r '.headRefOid')
BASE_OID=$(printf '%s' "$PR_META" | jq -r '.baseRefOid')
test "$(git rev-parse HEAD)" = "$HEAD_OID"
git diff --name-only "$BASE_OID...$HEAD_OID" | sort > "$REVIEW_TMPDIR/changed-files.git"
gh pr diff PR_NUMBER --name-only | sort > "$REVIEW_TMPDIR/changed-files.gh"
diff -u "$REVIEW_TMPDIR/changed-files.git" "$REVIEW_TMPDIR/changed-files.gh"
test -z "$(git status --porcelain)"
```

If any check fails in headless mode, stop without posting a review. Do not recover by changing directories or choosing another local checkout. For PR reviews, prefer exact SHA ranges such as `$BASE_OID...$HEAD_OID` over branch-name ranges.

### 1.1 Detect Base Branch

```bash
git remote show origin | grep 'HEAD branch' | awk '{print $NF}'
```

Fallback to `main` if the command fails. Allow override via `--base` argument.

### 1.2 Gather Changes

**Always fetch the base branch from the remote before diffing** to avoid stale merge-base issues where already-merged commits appear in the diff:

```bash
git fetch origin BASE_BRANCH
```

Determine the diff range. When reviewing a PR by number, also fetch the PR's head branch:

```bash
# Fetch PR head branch (when reviewing by PR number)
git fetch origin PR_HEAD_BRANCH

# Diff range uses origin/ refs to ensure freshness:
# - Default (on the branch locally): origin/BASE_BRANCH...HEAD
# - Remote PR review (by number):    BASE_REF_OID...HEAD_REF_OID after preflight verifies HEAD
# - Incremental (--since):           COMMIT_SHA...HEAD (or ...origin/PR_HEAD_BRANCH)
```

Run these commands (replace RANGE with the resolved diff range), and persist the full diff for sub-agents:
```bash
git diff RANGE --name-only          # Changed files list
git log RANGE --oneline             # Commit history
git diff RANGE --stat               # Change statistics
git diff RANGE > "$REVIEW_TMPDIR/pr.diff"  # Full diff for sub-agents to read
```

If no changes found, inform the user and stop.

**Important:** Never use a bare local branch name (e.g. `main`) in the diff range — always use `origin/BASE_BRANCH` to ensure you are comparing against the latest remote state. Using a stale local ref will include already-merged commits in the diff, leading to a review of code that is not part of the PR.

### 1.3 Detect Repo Context

Gather project context for sub-agents:
1. Read `AGENTS.md` if it exists, then `CLAUDE.md` if it exists (project rules and conventions)
2. Detect package manager (pnpm, npm, yarn, bun) from lock files
3. Detect monorepo config (turborepo.json, pnpm-workspace.yaml, nx.json)
4. Detect test framework (jest, vitest, playwright) from config files
5. Detect linting setup (eslint, biome) from config files

### 1.4 Extract Ticket

Search the branch name for ticket ID patterns — any alphanumeric prefix followed by a number (e.g. `PROJ-1234`, `FE-42`, `fix/TEAM-567-description`). Also check recent commit messages for ticket references.

If a ticket ID is found, retrieve its details using this discovery order:

1. **Check available skills**: Look at the skills listed in the system prompt. If one matches the ticket's project management system (e.g. a Linear skill for Linear IDs, a Jira skill for Jira IDs), invoke it using the Skill tool to fetch the ticket details.
2. **Check CLI tools**: Try common CLIs via Bash — `linear-cli issues get TICKET_ID --output json --compact --no-pager --quiet`, `jira issue view TICKET_ID`, `gh issue view NUMBER`, etc. Use `which` or `command -v` to check availability before running.
3. **Check MCP tools**: If MCP tools for project management are available, use those.

If none of these approaches succeed, note the ticket ID in the summary but skip the ticket compliance sub-agent.

If the ticket belongs to a project, also fetch lightweight related project context for contradiction checks. For Linear, prefer:

```bash
linear-cli issues list --project "PROJECT_NAME" --fields identifier,title,state,description,updatedAt,completedAt,canceledAt,url --output json --compact --no-pager --quiet
```

Limit the context passed to Sub-agent 5 to the most relevant 15-20 tickets, prioritising:

- Recent Done tickets, especially those completed in the last 30 days
- In Progress, Technical Review, and To Do tickets updated recently
- Tickets referenced by the current ticket description or comments
- Tickets with titles/descriptions that mention the same product area, status model, navigation, terminology, or acceptance criteria

Also fetch comments for the current ticket and any highly relevant related tickets when practical. The goal is not to perform a full project audit, but to give the ticket compliance sub-agent enough context to spot explicit contradictions with recent project decisions or completed scope.

**Important**: The ticket details and related project context MUST be fetched here in Phase 1, not in the sub-agent. Sub-agents cannot invoke skills. Pass the fetched ticket text (title, description, acceptance criteria, comments) and related project ticket context directly into Sub-agent 5's prompt.

### 1.5 Categorise Files

Group changed files into categories:
- **Frontend**: `.tsx`, `.jsx`, `.css`, `.scss`, files under `app/`, `components/`, `pages/`
- **Backend**: `.ts`, `.js` files under `server/`, `api/`, `services/`, `apps/` (non-frontend)
- **Database**: `.prisma`, `.sql`, files under `drizzle/`, `migrations/`, `prisma/`
- **Infrastructure**: `Dockerfile`, `docker-compose`, `.tf`, `Makefile`, files under `infra/`
- **Packages**: Files under `packages/`
- **Tests**: `.test.ts`, `.spec.ts`, `.test.tsx`, files under `__tests__/`, `test/`
- **Config**: `package.json`, `tsconfig.json`, `.eslintrc`, `turbo.json`, etc.
- **Docs**: `.md`, `.mdx` files

### 1.6 Fetch Conversation History

If a PR number is available (either passed via `--pr NUMBER` or detected via `gh pr view` against the current branch), fetch the existing review conversation so sub-agents can avoid re-raising things the team already discussed. **Skip this step entirely when reviewing a local branch with no associated PR.**

```bash
bash /path/to/skill/scripts/fetch-conversation.sh --pr PR_NUMBER > $REVIEW_TMPDIR/pr-prior-discussion.md
```

(Use the skill's base directory path for the script; pass `--repo OWNER/NAME` if `gh repo view` cannot infer the repo from the working directory.)

The script outputs a compact markdown document with two sections:
- **Line-comment threads** — each thread tagged `[RESOLVED]`, `[OUTDATED]`, or `[OPEN]`, with the file:line and the truncated message chain (latest reviewer → author → ...)
- **Issue-level discussion** — the PR's main conversation tab, one bullet per comment

If the script fails (network, auth, rate limit) or returns an empty document, proceed without prior-discussion context — do not block the review. Read `$REVIEW_TMPDIR/pr-prior-discussion.md` once after running the script; if it exists and is non-empty, pass its contents into every sub-agent prompt in Phase 2.

## Phase 2: Dispatch Sub-agents

Launch all applicable sub-agents in a SINGLE message. Do not create multiple prompt variations, do not deliberate about whether sub-agents might help, and do not dispatch agents one-by-one. After Phase 1 context is gathered and `references/finding-format.md` is read, immediately launch the fixed review streams below in one parallel dispatch.

Prefer the Pi `subagent` tool when available, using `tasks: [...]` parallel mode. Each task must use `agent: "delegate"` with no per-task model override, so review workers inherit the current parent model (for example Opus or GPT 5.5). These are review-only streams: give each task read-only inspection tools (`read`, `grep`, `find`, `ls`, `bash`) and explicitly forbid edits in the task prompt. If running under a Claude-style Task tool instead, use `subagent_type: "general-purpose"` and do not specify a model.

When using the `pi-subagents` package, prefer these options when they are present in the active tool schema. Capture the current working directory once with `pwd` after the preflight, and use that exact path for `cwd` so every child runs in the validated checkout:

```ts
subagent({
  tasks: [
    { agent: "delegate", task: "...", cwd: CURRENT_WORKING_DIRECTORY, tools: ["read", "grep", "find", "ls", "bash"] },
    // ...all other review streams use the same cwd
  ],
  cwd: CURRENT_WORKING_DIRECTORY,
  agentScope: "user",
  context: "fresh",
  concurrency: 4,
  clarify: false,
  async: false,
})
```

If a different `subagent` implementation is active and does not expose those options, omit unsupported options while preserving the core behaviour: parallel review tasks, no per-task model override, read-only/no-edit execution, and the generic delegate-style agent for each stream. `agentScope: "user"` intentionally avoids scanning repository `.agents/skills/**/SKILL.md` files as project-local executable agents.

Each sub-agent receives:
- The current working directory and an explicit instruction to stay there
- The base branch and diff range
- The exact path to the persisted full diff: `$REVIEW_TMPDIR/pr.diff` (do not invent a different `/tmp/pr-*.diff` path)
- The list of changed files with categories
- A summary of repo context (package manager, monorepo, test framework)
- The full contents of `AGENTS.md` and/or `CLAUDE.md` if either exists
- The finding format specification from `references/finding-format.md`
- The prior-discussion summary from `$REVIEW_TMPDIR/pr-prior-discussion.md` (if Phase 1.6 produced one)

Read `references/finding-format.md` and include its contents in every sub-agent prompt. Tell each sub-agent to read exactly `$REVIEW_TMPDIR/pr.diff` rather than recomputing a different diff or using a newly invented temporary diff path. If `$REVIEW_TMPDIR/pr-prior-discussion.md` exists and is non-empty, also read it and include its contents in every sub-agent prompt under a clear "Prior Discussion" heading.

### Sub-agent 1: Standards and Conventions

**Sub-agent config:** use `delegate`, inherit the parent model, and restrict tools to read-only inspection (`read`, `grep`, `find`, `ls`, `bash`). Do not specify a per-task model override. Do not edit files.

Prompt focus:
- Check whether the code follows project conventions from AGENTS.md/CLAUDE.md (naming, imports, file structure, British English)
- Only flag deviations that would cause real confusion or maintenance burden — not minor stylistic preferences
- Type safety (no `any` casts, proper type usage, `type` vs `interface`)
- Only flag issues in changed lines, not pre-existing code

### Sub-agent 2: Security and Performance

**Sub-agent config:** use `delegate`, inherit the parent model, and restrict tools to read-only inspection (`read`, `grep`, `find`, `ls`, `bash`). Do not specify a per-task model override. Do not edit files.

Prompt focus — Security:
- Hardcoded secrets, API keys, tokens in code or config
- Injection vulnerabilities (SQL, command, XSS, template)
- Missing authentication or authorisation checks
- Input validation gaps at system boundaries
- Insecure dependencies or patterns

Prompt focus — Performance:
- N+1 query patterns, missing database indexes
- Unbounded queries (no LIMIT, no pagination)
- Memory leaks (event listeners, unclosed resources)
- Unhandled promise rejections
- Large synchronous operations blocking the event loop

Prompt focus — Concurrency and data integrity:
- For ANY autosave, debounce, retry, fire-and-forget mutation, or optimistic-write flow, explicitly answer: (1) can two requests be in flight at once? (2) is completion ordering guaranteed? (3) is the server write conditional (revision/version/updatedAt guard) or plain last-write-wins? If two in-flight writes can complete out of order against an unconditional update, that is a lost-update race — flag it.
- Unmount/close/beforeunload "flush" saves are part of the same write path — check they cannot race an earlier in-flight request.
- Silent data-loss races in save/persistence paths are real findings even when the window is narrow (slow network + fast typing is a normal condition, not a theoretical one).

Security findings default to CRITICAL severity.

### Sub-agent 3: Architecture and Patterns

**Sub-agent config:** use `delegate`, inherit the parent model, and restrict tools to read-only inspection (`read`, `grep`, `find`, `ls`, `bash`). Do not specify a per-task model override. Do not edit files.

Prompt focus:
- Assess whether the approach is sound — does the architecture make sense for what the PR is trying to do?
- Sub-agent MUST search for comparable code using Grep/Glob before flagging any inconsistency
- Only flag pattern deviations that would cause actual confusion or bugs, not stylistic differences
- Check for duplicate functionality (search if similar utility already exists)
- Evaluate error handling, service communication, and database access patterns for correctness
- Consistency with an existing pattern is NOT evidence of correctness. When the diff mirrors or copies a pattern from elsewhere in the codebase ("same as the X page"), treat the copied logic as new, un-reviewed code and verify it on its own merits — the original may contain the same bug. If the source of the copy has the same defect, still flag the finding in this PR and note the pre-existing occurrence as a suggested follow-up.

Scoping: The sub-agent may read unchanged files to understand context, but must only flag issues the PR creates or worsens.

### Sub-agent 4: Test Coverage

**Condition:** Only dispatch if test files changed OR new code paths were added (new functions, new endpoints, new branches).

**Sub-agent config:** use `delegate`, inherit the parent model, and restrict tools to read-only inspection (`read`, `grep`, `find`, `ls`, `bash`). Do not specify a per-task model override. Do not edit files.

Prompt focus:
- Are the tests sufficient to have confidence in this change?
- Missing negative tests for important failure modes (not trivial guard clauses)
- Brittle tests that test implementation details rather than behaviour
- Tests that give false confidence (assertions that always pass, testing the wrong thing)

### Sub-agent 5: Ticket Compliance

**Condition:** Only dispatch if a ticket was found and its details were retrieved.

**Sub-agent config:** use `delegate`, inherit the parent model, and restrict tools to read-only inspection (`read`, `grep`, `find`, `ls`, `bash`). Do not specify a per-task model override. Do not edit files.

Prompt focus:
- Coverage of all requirements listed in the ticket
- Acceptance criteria met
- Scope creep — flag as SUGGESTION, not as a defect
- Missing pieces or edge cases mentioned in the ticket
- Requirements that appear partially implemented
- Contradictions between the current ticket/PR and related project ticket context

When related project ticket context is provided, check whether the current ticket or PR appears to contradict recent completed or in-flight tickets in the same project. Focus on explicit product contracts such as status models, navigation structure, terminology, acceptance criteria, UX invariants, permissions, or lifecycle rules.

Flag a contradiction only when all of these are true:

- A related project ticket clearly states a conflicting requirement or invariant
- The conflicting related ticket is recent, completed, in progress, or explicitly marked as the source of truth
- The PR implements the conflicting behaviour, or the current ticket requires it
- There is no explicit comment, description update, supersession note, or project note explaining that the previous decision was intentionally changed

Do not flag normal design iteration, vague differences, speculative conflicts, or old cancelled tickets unless they were explicitly superseded by a more recent completed ticket that still conflicts. If you do flag a contradiction, include the related ticket identifiers and quote or summarise the conflicting requirements. Use SHOULD_FIX when the contradiction affects shipped product behaviour; otherwise use SUGGESTION for a clarification request.

### Sub-agent 6: Build Validation

There are two modes depending on how the review was invoked:

**When reviewing a PR by number:** Do NOT run local build commands — they run against the wrong code and can cause side effects (e.g., turborepo writing cache/artifacts to a parent repo when running from a worktree). Instead, fetch GitHub CI status and Cloud Build details.

No sub-agent needed — run these in Phase 1 and include the results directly.

**Step 1 — Get check status from GitHub:**
```bash
gh pr checks PR_NUMBER --json name,state,link
```

**Step 2 — For any FAILED check with a Cloud Build link, fetch the build logs:**

Extract the build ID from the link URL (the UUID segment), then:
```bash
gcloud builds describe BUILD_ID \
  --region=europe-west2 \
  --project=lleverage \
  --account="dev-agent@lleverage.iam.gserviceaccount.com" \
  --format='json(status,steps.id,steps.status)'
```

If any step failed, get the raw logs and extract the relevant failure output:
```bash
gcloud builds log BUILD_ID \
  --region=europe-west2 \
  --project=lleverage \
  --account="dev-agent@lleverage.iam.gserviceaccount.com" 2>&1 | grep -A 50 "Step #N.*FAILED\|error TS\|ERR!\|FAIL " | head -60
```

**Report format:**

| Step | Status |
|------|--------|
| Format | PASS |
| Lint | PASS |
| Type Check | FAIL |
| Unit Tests | PASS |

For failures, include the first 20 lines of error output from the build logs. For PENDING builds, report PENDING and note the build is still running.

If Cloud Build access fails (permissions, auth), fall back to the `gh pr checks` pass/fail table with the console link.

**When reviewing the current local branch (no PR number):**

**Sub-agent config:** use `delegate`, inherit the parent model, and restrict tools to read-only inspection (`read`, `grep`, `find`, `ls`, `bash`). Do not specify a per-task model override. Do not edit files.

Run the following commands and report results:
1. **Type check**: Detect and run the project's type-check command (`pnpm type-check`, `npx tsc --noEmit`, etc.)
2. **Lint**: Detect and run the project's lint command (`pnpm lint`, `npx eslint .`, etc.)

Do NOT run tests — they take too long and will run as part of CI anyway.

Report a table with PASS / FAIL / NOT AVAILABLE for each check. For failures, include the first 20 lines of error output.

### Instructions for ALL Sub-agents

Include these instructions verbatim in every sub-agent prompt:

Your job is to assess whether this code is ready to merge. The expected answer is yes — most PRs are fine. You are not looking for things to criticise; you are looking for reasons to block or genuinely useful improvements.

CRITICAL and SHOULD_FIX = things that would make you block this PR in a real code review. These must be verified — read the surrounding code (not just the diff) to confirm that no existing guard, fallback, or handler already addresses the concern. If the issue is about a code path ("X could happen"), trace it to confirm it is actually reachable. A false positive at high severity is worse than a missed suggestion.

SUGGESTION = things the author would genuinely thank you for pointing out. Maximum 3 suggestions per agent. If you have more, keep only the most useful ones.

These are NOT findings — do not report them:
- Missing tests for trivial branches, early returns, or guard clauses
- Slightly broad hook dependencies (useEffect, useMemo) that cause harmless no-ops
- Theoretical edge cases that require multiple unlikely conditions to manifest — EXCEPT silent data loss in save/write paths: a lost-update or out-of-order-write race in an autosave, flush, or persistence flow is a real finding even when the window is narrow
- Stylistic preferences when the current approach works correctly
- Types that could be narrower but are correct as-is
- An approach that works but could use a different pattern

Do not let provenance substitute for analysis: code that mirrors an established pattern elsewhere in the codebase, or that survived earlier bot/human review rounds on this PR, is NOT automatically correct. Prior reviewers auditing their own known findings is not the same as the code being verified — run your own checks (especially concurrency/ordering on any debounced or fire-and-forget write path) regardless of what previous reviews concluded.

**Respect prior discussion.** If a "Prior Discussion" section is included in your prompt, scan it before drafting any finding. For each finding you intend to raise, search the prior discussion for threads on the same file:line range or topic and apply this rule:

- **Thread tagged `[RESOLVED]`**: do NOT re-raise. The team explicitly closed it. Only override this if the new commits demonstrably reintroduce the exact issue — and say so in the `why` field.
- **Thread tagged `[OUTDATED]`**: the line the comment referred to no longer exists in the diff. Do NOT re-raise unless the same concern applies cleanly to the current code.
- **Thread tagged `[OPEN]` where the author replied with reasoning and the reviewer accepted it** (look for "fair", "agreed", "ok", "lgtm", "👍", or a reviewer message ending without further objection): treat as resolved off-thread. Do NOT re-raise.
- **Thread tagged `[OPEN]` where the author replied with reasoning and the reviewer has not yet responded**: the author has put the ball back in the reviewer's court. Do NOT re-raise the same concern as a finding — instead, if the concern still seems valid, note it as a `SUGGESTION` and acknowledge the open thread in the `why` field (e.g. "Open thread on this; restating because the author's reasoning does not address X").
- **Thread tagged `[OPEN]` with no author response**: you may raise the finding, but in the `why` field add "Prior thread on this is still open with no author response."
- **No prior thread on this file/line/topic**: raise normally.

The goal is to never make the author re-defend a point they already addressed. The cost of skipping a real issue once is much lower than the cost of re-raising something the team already settled.

Contextual-file verification: if a finding depends on an unchanged file outside the PR diff, verify that file from the validated PR context before reporting it. Use the isolated worktree whose HEAD passed the `--pr` preflight, or use `git show HEAD:path/to/file` / `git show "$BASE_OID:path/to/file"`. Do not cite file contents from a dirty or unrelated local branch.

Follow the finding format from the specification exactly. Only report findings with confidence at or above 80. List the files you reviewed — for files with findings, include the count; files without findings need only be listed. If you find nothing noteworthy, say so clearly. Do NOT manufacture findings to justify your existence. An empty category is a good sign, not a failure.

## Phase 3: Synthesise

Once all sub-agents return, process their findings:

### 3.1 Deduplicate

If multiple agents flag the same file + line range:
- Keep the most specific finding (the one with the clearest explanation and fix)
- Use the highest severity from the duplicates
- Note which agents independently identified the issue (increases confidence)

### 3.2 Filter Noise

Before cross-referencing with build, filter out low-value findings:
- Drop findings that are stylistic preferences when the current approach is correct
- Drop findings about theoretical edge cases that require multiple unlikely conditions
- Drop findings about test coverage for trivial code paths (early returns, guard clauses)
- Cap total suggestions at 3 across all agents — keep the most useful ones
- If no CRITICAL or SHOULD_FIX findings remain after filtering, keep the final output short

### 3.3 Cross-reference with Build

If build validation found type-check or lint failures:
- Link errors to related findings from other agents
- Elevate related findings if they explain the failure
- Add build context to the finding description

### 3.4 Sort and Prioritise

Order findings by severity, then by confidence:
1. **CRITICAL** (confidence 90-100): Must fix before merge
2. **SHOULD_FIX** (confidence 80-89): Important, should address
3. **SUGGESTION** (explicitly marked): Optional improvements

### 3.4.1 Verdict Thresholds

The verdict follows from the surviving findings. Only CRITICAL findings block a merge:

| Surviving findings | Verdict | Blocking? |
|---|---|---|
| ≥1 CRITICAL | REQUEST_CHANGES | Yes |
| ≥1 SHOULD_FIX, no CRITICAL | CHANGES_SUGGESTED | No — posted as a comment |
| Only suggestions | APPROVE_WITH_SUGGESTIONS | No |
| Nothing | APPROVE | No |

CHANGES_SUGGESTED deliberately does not set a blocking review state: the findings are worth fixing, but they are not worth deadlocking the PR over — a human code owner will see them when approving. Do not inflate a SHOULD_FIX to CRITICAL to force a block; a CRITICAL must be a demonstrable defect (data loss, security, corruption, broken build, user-visible breakage) that you verified is reachable.

### 3.5 Count Totals

Calculate totals per severity for the summary section.

### 3.6 Identify Positives

Only note genuinely notable things — skip this section entirely if nothing stands out. Do not pad with generic praise like "good error handling" or "clean code."

### 3.7 Adversarial Approval Gate (devil's advocate)

Every earlier phase is biased towards approval by design (verification requirements, confidence thresholds, suggestion caps). This gate is the counterweight against false negatives. **If, and only if, the provisional verdict is APPROVE or APPROVE_WITH_SUGGESTIONS**, dispatch one additional sub-agent before Phase 4. Run it exactly once — do not loop, and do not run it when the verdict is already REQUEST_CHANGES.

**Sub-agent config:** use `delegate`, inherit the parent model, and restrict tools to read-only inspection (`read`, `grep`, `find`, `ls`, `bash`). Do not edit files.

Give it: the diff path (`$REVIEW_TMPDIR/pr.diff`), the changed-file list, AND the draft approval summary (2-3 sentences of what the provisional review concluded and what it claims to have verified).

Prompt (adapt, keep the framing):

> A prior review has provisionally APPROVED this PR. Assume that approval is WRONG and there is at least one merge-blocking defect the review missed. Your job is to find it. Do not re-verify what the draft approval says was checked — attack what it does NOT mention. Hunt specifically in the places approval bias hides bugs: concurrency and ordering on write paths (two in-flight requests, out-of-order completion, unguarded last-write-wins), lifecycle edges (unmount, close, navigation, cancellation, retries), error and partial-failure paths, stale cache/refetch interactions, boundary states (empty, deleted, permission-edge), and mismatches between what the UI promises ("Saved") and what the server guarantees. Treat any code that "mirrors an existing pattern" as unverified. For each candidate defect, trace the real code and construct a concrete step-by-step failure scenario a user could plausibly hit. Report only defects you can demonstrate this way, in the standard finding format. If after genuine effort you cannot demonstrate one, reply exactly "No demonstrable blocker found" — a manufactured finding here is worse than none, because it erodes the gate's credibility.

Handling the result:

- **"No demonstrable blocker found"** — proceed to Phase 4 with the approval. Do not mention the gate in the output.
- **Findings returned** — verify them yourself with the same rigour as any other finding (read the code, confirm reachability). Discard anything that does not survive verification. Only a surviving **CRITICAL** flips the verdict to REQUEST_CHANGES. A surviving SHOULD_FIX moves the verdict to CHANGES_SUGGESTED (non-blocking) and is included normally; surviving SUGGESTIONs join the suggestion pool (still capped at 3). The gate exists to stop demonstrable merge-blocking defects, not to relitigate the approval on judgement calls.
- **Sub-agent failure/timeout** — proceed with the provisional verdict; note nothing.

## Phase 4: Present

### Default: Conversational Output

Present a structured summary. The output length should match the severity of the findings — clean PRs get short reviews.

**For APPROVE verdict** (no critical or should-fix findings):

1. **Verdict**: APPROVE
2. **Summary**: 2-3 sentences on what the PR does and that it looks good
3. **Build Status**: Table of type-check and lint results
4. **What's Good** (optional): Only if something is genuinely notable — skip if nothing stands out
5. **Files Reviewed**: Collapsible list

**For APPROVE_WITH_SUGGESTIONS** (only suggestions, no blockers):

1. **Verdict**: APPROVE_WITH_SUGGESTIONS
2. **Summary**: 2-3 sentences
3. **Build Status**: Table of type-check and lint results
4. **Suggestions**: Max 3 items, each with file/line, what, why, fix
5. **Files Reviewed**: Collapsible list

**For CHANGES_SUGGESTED** (should-fix findings, no criticals — non-blocking):

1. **Verdict**: CHANGES_SUGGESTED
2. **Summary**: 2-3 sentences, stating explicitly that nothing blocks the merge
3. **Build Status**: Table of type-check and lint results
4. **Should Fix**: Each finding with file/line, what, why, fix
5. **Suggestions** (if any, max 3)
6. **Files Reviewed**: Collapsible list

**For REQUEST_CHANGES** (at least one critical finding):

1. **Verdict**: REQUEST_CHANGES
2. **Summary**: 2-3 sentences
3. **Build Status**: Table of type-check and lint results
4. **Ticket Compliance** (if applicable): Brief assessment of requirement coverage
5. **Findings by Severity**: Grouped sections, each finding with file/line, what, why, fix
6. **Suggestions** (if any, max 3)
7. **Files Reviewed**: Collapsible list

### GitHub Output (--post flag)

When the user requests posting to GitHub:

Before formatting GitHub output, initialise `REVIEW_TMPDIR` exactly as described in the Review Temporary Directory section and write every generated artifact there.

1. Read `references/github-output.md` for the complete template, formatting rules, and inline comment format
2. Format the synthesised findings into body markdown and write to `$REVIEW_TMPDIR/pr-review.md`
3. For each CRITICAL and SHOULD_FIX finding, format an inline comment using the inline comment template from `references/github-output.md` and collect into `$REVIEW_TMPDIR/pr-review-inline.json`. SUGGESTION findings do NOT get inline comments.
4. Map the verdict to a review event (see event mapping table in `references/github-output.md`)
5. Post via: `bash /path/to/skill/scripts/post-review.sh --body $REVIEW_TMPDIR/pr-review.md --inline $REVIEW_TMPDIR/pr-review-inline.json --event EVENT --pr PR_NUMBER` (use the skill's base directory path for the script)

**Important:** Always pass `--pr PR_NUMBER` to target the correct PR explicitly. Do not rely on auto-detection from the current branch — it can target the wrong PR when running from a worktree or detached HEAD.

If updating an existing review comment, use `--edit-last` flag (inline comments are skipped on updates to avoid duplicate threads).

**Never call `gh pr review` directly.** The script handles both the review body and the approval/request-changes event in a single atomic API call, preventing duplicate reviews. Calling `gh pr review` separately will create a second review.

## Incremental Re-review

When `--since COMMIT_SHA` is provided, the review shifts from a full assessment to a delta report — showing what changed since the last review.

### Context Gathering (incremental)

1. Narrow the diff to `COMMIT_SHA...HEAD` — only new commits are reviewed
2. Retrieve the previous review by reading the most recent PR review that contains "Approved", "Approved with Suggestions", or "Changes Requested" in an H2 heading (use `gh api` to list reviews)
3. Parse the previous review to extract its findings (file, lines, title, severity)
4. Run the full sub-agent analysis on the narrowed diff as normal

### Synthesise (incremental)

After sub-agents return, classify every finding into one of three categories:

**Resolved** — A finding from the previous review where:
- The file + line range was modified in the new commits, AND
- The issue described is no longer present in the current code
- If unsure whether it's truly fixed, read the current file to verify

**Still Open** — A finding from the previous review where:
- The file + line range was NOT modified in the new commits, OR
- The file was modified but the issue persists

**New** — A finding from the current review that:
- Was not present in the previous review (different file, different line range, or different issue)
- Applies only to code introduced in the new commits

**No moving target.** A re-review is an audit of the delta, not a fresh chance to re-litigate the whole PR. A NEW finding on code that the new commits did not touch means the earlier review missed it — that is the reviewer's miss, not the author's regression. Such a finding may only be raised as a blocker if it is a verified CRITICAL (demonstrable data loss, security, corruption, or user-visible breakage), and the `why` field must acknowledge it was missed earlier. Anything below CRITICAL on untouched code is at most a SUGGESTION. Never escalate the severity floor across rounds: if earlier rounds blocked on criticals, do not block a later round on style, naming, token, or convention findings that were visible from round one.

### Present (incremental)

The incremental output uses a different structure from the full review. The three categories (Resolved, Still Open, New) replace the severity-grouped sections.

**Conversational output:**

1. **Header**: "Incremental review since `COMMIT_SHA`" with counts: N resolved, N still open, N new
2. **Resolved**: List with strikethrough titles — brief confirmation each was addressed
3. **Still Open**: Full finding details grouped by severity, same format as the full review
4. **New Findings**: Full finding details grouped by severity, same format as the full review
5. **Build Status**: Fresh build results from this run
6. **Verdict**: Based on the combined Still Open + New findings (resolved findings don't count)

**GitHub output:**

Always post as a **new comment** (never `--edit-last`) so the PR timeline shows progression. Read `references/github-output.md` for the incremental template format. Only generate inline comments for NEW findings — still-open findings already have conversation threads from the prior review.

### Edge Cases

- **No previous review found**: Fall back to a full review. Note in the summary: "No previous review found — performing full review."
- **Previous review can't be parsed**: Fall back to a full review with the narrowed diff. Note: "Could not parse previous review — reviewing new commits only, without delta tracking."
- **All previous findings resolved**: Celebrate briefly. Verdict based on new findings only.

## Headless Mode

When `--headless` is passed, the review runs fully non-interactively — designed for CI pipelines, GitHub Actions, or any automation that invokes Claude without a human in the loop.

**Behavioural overrides in headless mode:**

1. **Never ask questions.** Do not use AskUserQuestion under any circumstances. If something is ambiguous (multiple possible base branches, unclear ticket ID, etc.), make a best-effort decision and move on.
2. **Always post to GitHub.** Headless implies `--post`. The GitHub PR comment is the sole output — do not produce conversational text.
3. **Silent degradation.** If ticket tools are unavailable, skip ticket compliance without mentioning it in the summary. If a sub-agent fails or times out, continue with partial results — do not suggest re-running.
4. **No confirmation for build commands.** Run type-check, lint, and test commands without hesitation. These are read-only verification steps.
5. **Fail cleanly on no PR.** If `gh pr view` shows no open PR for the current branch, exit with a single line: "No open PR found for this branch." Do not offer to create one.
6. **Fail cleanly on no changes.** If no diff is found, exit with a single line: "No changes found between the base branch and HEAD."

**Example CI invocation:**

```bash
claude -p "/pr-review --headless"
```

Or with a specific base branch:

```bash
claude -p "/pr-review --headless --base main"
```

## Error Handling

### No changes detected
Inform the user: "No changes found between the base branch and HEAD. Make sure you have commits on your branch."

### Ticket details unavailable
Skip ticket compliance, note in the summary: "Ticket compliance not checked (no project management tool available to fetch ticket details)."

### Build command not found
Report NOT AVAILABLE for that check. Do not fail the review.

### Sub-agent timeout or failure
Report partial results from successful agents. Note which agents failed and suggest re-running.

### Inline comment posting fails
Body comment is always posted first. If inline review submission fails, warn the user. All findings remain in the body comment. Do not retry.
