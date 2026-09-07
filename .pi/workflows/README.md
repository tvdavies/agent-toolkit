# Saved workflows

Reusable multi-agent workflows for the dev flows we otherwise do by hand, each encoding the
same shape: **research/map → plan/hypothesise → implement/synthesise → review (adversarial)**.
They run on the Pi workflows engine (`extensions/workflows`), which gives bounded concurrency,
shared token budgets and isolated child clones. Each flow assigns its own
verification responsibilities; isolation alone does not make commands safe or
prove a patch was verified.

## The workflows

| Workflow | `args` | Flow |
|---|---|---|
| `debug-issue` | a failing test name, an error/stack trace, or a bug report | Reproduce + Map → Hypothesise (diverse, evidence-backed) → Verify (skeptics refute each) → Fix + Verify (minimal fix in a worktree, re-run green) |
| `implement-ticket` | a Linear/tadu ticket id, or a change description | Understand (fetch ticket + map code) → Plan (judge panel scores N approaches) → Implement (in a git worktree, code + tests) → Review (adversarial) |
| `review-pr` | a PR number (optionally `{ pr, post: false }`) | Context (pinned diff + prior discussion + CI) → Review (6 dimensions) → Verify (refute each finding) → deterministic report with coverage. Report-only; rejects `post:true` before any child starts. |

## Running them

Each saved workflow is auto-registered as a command, and is also runnable via the tool:

```
/debug-issue the auth cache test fails: AssertionError pwdVersion undefined
/implement-ticket LLE-1234
/review-pr 4811

# or, from the tool / another workflow:
workflow_run mode:'saved' name:'review-pr' args:'4811'
/workflows           # list saved workflows + recent runs
```

## Safety

- `implement-ticket` uses isolated Git clones. By default, once tests and review pass it may commit a feature branch, push it, and open or update a PR. Pass `{ noPr: true }` (or ask to leave it in the workspace) to preserve the reviewed diff without shipping.
- `review-pr` is **report-only**. `post:true` is unsupported and rejected before
  work starts, not accepted then silently ignored. Workflow children cannot use
  host-installed skill helper paths in arbitrary target repositories. For
  publication, use the portable `pr-review` skill with `--post` (or explicit
  caller publishing policy), exact reviewed head, and its bundled helper.
  Headless mode alone never authorizes posting. The saved flow returns
  `coverage`, `coverageComplete`, `verdict`, `reviewedHead`, findings and report.
- Skill and flow share the severity/coverage contract bundled at
  `skills/general/pr-review/references/severity-verdict.md`: only CRITICAL maps
  to REQUEST_CHANGES; SHOULD_FIX maps to nonblocking CHANGES_SUGGESTED.
  Missing required review/CI/ticket evidence prevents full approval. Version 2
  child failures normally throw; missing-result guards are defensive, not a
  claim that production failures normally return null.
- `debug-issue` uses runtime `returnMetadata` and `patches` to verify the exact
  preserved diff against the run's pinned base (HEAD plus tracked launch changes).
  Patch-application failure stops; the verifier never reimplements. A verifier
  that changes the seeded tree or reports a different base cannot certify the
  original. `fix.diffPath`, `workspacePath`, `baseHead`, and `agentId` identify
  the artefact; `verification.verifiedPatchPath` identifies the patch assessed,
  and only `verification.confirmed: true` certifies success. The old model-written
  `fix.diff` string is no longer returned as if it were authoritative.
- `implement-ticket` retains its three-approach/nine-judge planning panel. One
  independent regression-risk reviewer owns execution per revision; other
  lenses inspect and add only concern-driven targeted checks. Post-fix execution
  also has one independent owner. Repeated repairs/checks are bounded, and
  missing independent execution evidence cannot be replaced by an implementer's
  green claim. An unknown test command blocks instead of guessing a runner.
- Every child starts from the run's pinned tracked snapshot in a unique clone. Tools are allowlisted; Bash sees only minimal runtimes plus that clone and is networkless by default. Cross-stage changes move explicitly as preserved diffs. Calls that need external access declare `network: true`; GitHub calls additionally declare `githubAuth: true` for an ephemeral token.

## Editing / distribution

These are the canonical sources, discovered automatically when working inside this repo.
`scripts/sync.sh` reconciles managed links in `~/.pi/agent/workflows/` so the commands work from any repo. This is local installation, not Dispatch skill vendoring; cross-repository updates need separate review. Run it after adding or removing a workflow. Existing linked workflow contents update live, but active Pi sessions still need `/reload` to rebuild their command inventory.

Relationship to skills: the `pr-review` skill remains for conversational, single-session review;
`review-pr` is the deterministic multi-agent version and reuses the same dimension design.
