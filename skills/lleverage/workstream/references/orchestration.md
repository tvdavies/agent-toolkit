# Orchestration loop

Shared by `/workstream` (one top-level issue) and `/sweep` (the cycle). The
orchestrator plans, dispatches, routes and verifies. Implementer subagents write
code. The orchestrator never edits code itself, except for trivial one-liners on
a PR it already owns.

## State: durable, one directory per workstream

`WS_DIR=~/.local/state/workstreams/<name>` (the root issue for `/workstream`, for
example `lle-13601`; `sweep-<cycle>` for a sweep). Never put state in `/tmp`: it was
wiped mid-run on 2026-10-05, along with the state file and scripts.

| File | Contents |
|---|---|
| `STATE.md` | Mandate, exclusions, decisions taken, agent roster, human action queue, next checks. Rewrite the relevant section whenever it changes, not as a log. |
| `prs.tsv` | Every PR the workstream owns, maintained by `scripts/pr-ledger.sh`. |
| `issues.log` | Every issue created, written by `scripts/followup.sh`. |
| `brief.md` | The implementer brief for this workstream (from `implementer-brief.md`). |
| `baseline-health.txt` | The first health snapshot, for comparison. |
| `health-extra.sh` | Optional workstream-specific health checks. |
| `journal.md` | Timestamped one-liners: decisions, incidents, merges. Append only. |

After every compaction or restart, read `STATE.md`, run `pr-ledger.sh list` and the
queue script, and re-establish monitors before doing anything else. Crons and
monitors don't survive a restart; the state directory does.

Structure `STATE.md` like this:

```markdown
# <name> — <mandate in one line>
Updated: <UTC>
## Mandate and stop condition
## Exclusions (other owners)        # trees, tickets, shared resources such as SDK releases
## Decisions                         # product/technical decisions with who made them
## Agents                            # name | ticket | worktree | PR | phase | last heard (UTC)
## Human action queue                # one numbered list: what, why, link, since when
## Waiting on                        # dependency edges: X starts when Y merges/deploys
## Next checks                       # health tick, deploy verification, soak end times
```

## The loop

Repeat until the stop condition holds:

1. **Refresh.** Run the queue script (`linear-queue.sh tree ROOT` or `cycle`),
   `pr-ledger.sh list`, and check main CI. Never plan from memory or from an
   earlier listing. Cancelled, reassigned and other-session tickets change under you.
2. **Reconcile.** Each agent in the roster must have reported within its liveness
   window (30 minutes when implementing, or when its PR has `need≠none`). If it is
   silent, check its worktree's mtime and the PR, then message it. If it is dead,
   hand its PR to a new owner with an explicit handoff.
3. **Wake dependants.** For every `Waiting on` edge whose condition now holds,
   move the dependant to ready. A prerequisite merging must start its dependants
   at once. (#7555 sat for 36 hours on 2026-10-02.)
4. **Dispatch** to capacity (below), in this order: production-impacting fixes,
   then the critical path, then highest value per effort.
5. **Wait on events**, not on a timer: monitor output (the PR watcher, deploy
   watchers) and agent reports. Then go back to 1.

When there is nothing to dispatch, go through `When the queue looks empty` before
reporting idle.

## Capacity

- Implementers: 4–6 at once. Investigators (read-only Sol agents): up to 4 more.
- Before launching an agent that runs heavy suites (integration, the full app
  vitest), check `uptime`. If the load is above 2× the core count, queue it.
  Machine load reached ~50 on 2026-10-02 and caused timeouts that looked like flakes.
- On HTTP 429 or a usage error, classify it first. A weekly or account cap is not
  a concurrency problem: stop, record the state, and tell Tom. A per-minute rate
  limit means back off and resume with one fewer agent. Never silently slow down.
- Gateway or provider auth failures (`503 auth_unavailable`): checkpoint
  `STATE.md`, report once, and retry on the next tick.

## Dispatching an implementer

Every implementer prompt contains:

- the ticket ID, plus the parent context and decisions it needs (paste them; the
  agent can't see this conversation);
- the exact worktree command, with a unique path:
  `git -C <main checkout> worktree add -b <branch> <path> origin/main`
  (agents inherit the orchestrator's cwd and otherwise edit the session tree);
- the scratch directory `$WS_DIR/<ticket>/`;
- `brief.md` (read it, then follow `~/.claude/skills/yolo-ticket/SKILL.md`);
- known siblings touching the same files or registries, and their contracts;
- the stop condition: merged, or a precise blocker.

Launch with `run_in_background: true`. Record the agent in the roster at once and
add its PR to the ledger as soon as it exists (`pr-ledger.sh add <repo> <n> <ticket> <agent>`).

**Report routing.** Background notifications reach the top-level session, so a
nested reviewer's report lands with you, not with the implementer that asked for
it. Whenever an "independent review of X" result arrives, forward it in full with
SendMessage to X's owner straight away. Briefs tell implementers to run reviewers
in the foreground so this rarely happens.

## One watcher for all PRs

Start one Monitor on `WS_DIR=... pr-ledger.sh watch` (timeout 30 minutes, re-armed
on expiry) for every repo, infra included. Act on each line:

| Event | Action |
|---|---|
| `CHANGE … need=ci-failed` | Check whether the same suite fails on `origin/main`. If so, it is a main problem: fix main first. Otherwise route it to the owner. |
| `CHANGE … need=changes-requested / threads` | Route to the owner at once. If the owner is gone, spawn a babysitter with `babysit-pr`. |
| `CHANGE … need=conflict` | Route to the owner, naming the PR that caused the conflict. |
| `CHANGE … need=approved-not-armed` | Arm auto-merge per the merge policy, or add to the human queue for infra. |
| `ATTENTION …` | Something has been stuck for 20 minutes. Treat it as a defect in the orchestration: fix the ownership. |
| `MERGED …` | Update the roster. Refresh sibling PRs touching the same files. Start deploy verification (verification.md). Wake dependants. |
| `CLOSED …` | Confirm it was intended (superseded) and that nothing depends on it. |

A watcher that only tracks the merge is not babysitting: a change request blocks
auto-merge silently. Every open PR has exactly one owner, and the ledger records it.

## Human action queue

Tom's attention is the scarcest resource. Keep **one** numbered list in `STATE.md`:
infra merges, decisions, credentials. When adding to it:

- check the live state first (`gh pr view`, Linear). Never ask for something
  already done;
- batch it. Send the whole queue in one message, then don't repeat it until it
  changes;
- after Tom acts, verify the effect yourself (rollout, Argo, flags) and close the
  item without asking him to confirm.

Things that are not human actions: decisions already covered by the mandate,
repeated permission for the same class of action, and "should I file a ticket for
this?" (follow `issues.md` instead).

## When the queue looks empty

Do not report idle until each of these steps has found nothing:

1. Re-run the queue script. Also check the team's Triage and recently reassigned
   tickets, which arrive mid-run.
2. For every `blocked` or "needs staff/staging" ticket, check the blocker live.
   Agents have the staging kubeconfig (writable for tests), read-only prod Loki and
   the session DB, and Snyk. Retry access that failed earlier.
3. Run investigators on the highest-value unready tickets to get them ready
   (`issues.md`, Readiness).
4. Pick up gaps in verification: soak checks, deferred rollout checks, umbrella
   tickets whose children are all closed.

Then report idle once, listing each remaining ticket and its precise blocker.

## Talking to Tom

- Report transitions and exceptions only. Don't send "no change" messages: if a
  tick finds nothing, write one line in `journal.md` and say nothing.
- "What are you running?" is answered from the roster and ledger in under 15 lines.
- Notify (PushNotification) only for: prod unhealthy because of our change, a
  decision blocking the critical path, or the stop condition reached.
- Keep separate: **merged**, **deployed**, **verified live**, **accepted**.
