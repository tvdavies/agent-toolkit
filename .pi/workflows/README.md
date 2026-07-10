# Saved workflows

Reusable multi-agent workflows for the dev flows we otherwise do by hand, each encoding the
same shape: **research/map → plan/hypothesise → implement/synthesise → review (adversarial)**.
They run on the Pi workflows engine (`extensions/workflows`), which gives bounded concurrency,
shared token budgets, worktree isolation, and adversarial verification for free — so the flow
is consistent every time instead of re-derived per run.

## The workflows

| Workflow | `args` | Flow |
|---|---|---|
| `debug-issue` | a failing test name, an error/stack trace, or a bug report | Reproduce + Map → Hypothesise (diverse, evidence-backed) → Verify (skeptics refute each) → Fix + Verify (minimal fix in a worktree, re-run green) |
| `implement-ticket` | a Linear/tadu ticket id, or a change description | Understand (fetch ticket + map code) → Plan (judge panel scores N approaches) → Implement (in a git worktree, code + tests) → Review (adversarial) |
| `review-pr` | a PR number (optionally `{ pr, post }`) | Context (diff + prior discussion) → Review (6 dimensions, one agent each) → Verify (refute each finding) → Synthesise (prioritised report) |

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
- `review-pr` is **read-only** — it never posts to GitHub unless explicitly authorised.
- Every child starts from the run's pinned tracked snapshot in a unique clone. Tools are allowlisted; Bash sees only minimal runtimes plus that clone and is networkless by default. Cross-stage changes move explicitly as preserved diffs. Calls that need external access declare `network: true`; GitHub calls additionally declare `githubAuth: true` for an ephemeral token.

## Editing / distribution

These are the canonical sources, discovered automatically when working inside this repo.
`scripts/install.sh` copies them to `~/.pi/agent/workflows/` so the commands work from any repo.
After editing one here, re-run the install (or copy it across) to update the global copy.

Relationship to skills: the `pr-review` skill remains for conversational, single-session review;
`review-pr` is the deterministic multi-agent version and reuses the same dimension design.
