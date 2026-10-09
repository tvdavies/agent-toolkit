---
name: sweep
description: Autonomously work through the current cycle. Finds high-value, ready Linear tickets that nobody is working on and that don't sit under an in-progress parent, gets unready ones ready, and delivers them through parallel yolo-ticket subagents with one PR watcher and prod health checks. Safe to run alongside /workstream sessions. Use only when the user explicitly invokes /sweep or explicitly asks to yolo or sweep the cycle.
compatibility: Requires git, GitHub CLI, jq, linear-cli, and the workstream, prod-health, yolo-ticket, start-ticket and babysit-pr skills.
disable-model-invocation: true
metadata:
  author: tvd
  version: 1.0.0
---

# Sweep

Deliver as much high-value ready work from the current cycle as possible, without
touching work that someone else owns. Several sweeps and workstreams can run at
once; the eligibility rules below keep them apart.

This skill reuses the workstream machinery. Read these before starting, and again
after a compaction:

- `../workstream/references/orchestration.md`: state, the loop, capacity, the
  PR watcher, the human queue, the empty-queue procedure, and communication
- `../workstream/references/issues.md`: writing tickets, readiness, slicing,
  follow-ups, done, closeout. Every ticket a sweep creates or rewrites follows
  its "Writing tickets" rules.
- `../workstream/references/merge-and-review.md`
- `../workstream/references/verification.md`
- `../workstream/references/implementer-brief.md`

Scripts: `../workstream/scripts/{linear-queue.sh,pr-ledger.sh,followup.sh}`.
PR waiting goes through prwatch (install: `npm i -g @tvdavies/prwatch@^0.1.3`; upgrade:
`npm i -g @tvdavies/prwatch@latest && prwatch daemon restart`): the
ledger watcher uses it when installed, and agents wait with `prwatch wait --since`
or a Monitor on `prwatch events`, never ad hoc `gh pr view` or `gh api graphql`
loops. Prefer REST for one-off reads when GraphQL is rate-limited (`prwatch rate`);
writes (merge, auto-merge, comments, review requests) still use `gh`. See
"Waiting on GitHub: prwatch" in `../workstream/references/orchestration.md`. Health
checks: the `prod-health` skill (`../prod-health/scripts/prod-health.sh`), run at
start-up, after merge bursts and every two hours, with its severity response.

## Arguments

Optional scope: a team key (default `LLE`), `--all-assignees` (default: issues
assigned to Tom), a project name, or extra exclusions. Any further text is mandate.

## Eligibility

Re-evaluate eligibility from fresh data immediately before every dispatch, using
`linear-queue.sh cycle [--team T] [--all-assignees]`. A ticket is eligible only
when all of these hold:

- its verdict is `eligible`, meaning:
  - no ancestor is in a started state (In Progress, Technical Review, …). That
    tree is claimed by a workstream or a person;
  - it isn't started itself;
  - no open PR mentions it;
  - it has no open blocker;
  - it isn't a parent with open children;
- it isn't listed under Exclusions in `STATE.md`, and Tom hasn't said another
  session owns it;
- no local worktree or branch from another session exists for it (`git worktree list`);
- it meets the readiness bar in `issues.md`. If not, it goes to a `prepare-ticket`
  subagent, not to an implementer.

When you start a ticket, set it In Progress at once (yolo-ticket does this). That
is the claim. If a ticket you were about to start changes state underneath you,
drop it. Never move another session's ticket back to To Do.

Don't claim a parent to work its children from a sweep. A ticket big enough to
need slicing is a `/workstream` candidate: slice it only if Tom's mandate allows,
and then run that tree as a workstream (claim the parent, follow the workstream
phases) inside this sweep, recorded in `STATE.md`.

## Selection

Rank eligible, ready tickets by:

1. production impact (incidents, customer-reported bugs, security);
2. priority (Linear 1 urgent → 4 low; 0 means no priority and sorts last);
3. value per effort: small, well-understood, independent of others in flight;
4. lane fit: avoid running two tickets that touch the same files at the same time.

Batch triage: at start-up, give 2–3 read-only investigators batches of about 12
tickets each, to sort them quickly. Full preparation of a single ticket is
`prepare-ticket`'s job. Each returns, per ticket: ready (y/n), size, files, blocker, impact.
Record the verdicts in `STATE.md` with a timestamp. Verdicts older than a day get
re-checked before dispatch.

## Set-up

1. `WS_DIR=~/.local/state/workstreams/sweep-<cycle-number>`. Write `STATE.md`
   with the mandate, the exclusions (other sessions' trees Tom mentioned, plus
   every started parent the queue reports as `claimed`), and the stop condition
   (default: the cycle ends, or nothing eligible remains after the empty-queue
   procedure).
2. Read `MEMORY.md` for temporary exceptions. Write `brief.md`. Capture the
   baseline health. Start the PR watcher.
3. Settle authority questions in one message (staging promotion, infra PRs).

## Run

Follow the loop in `orchestration.md`, with `linear-queue.sh cycle` as the queue.
Keep 4–6 implementers busy. Follow "Ending a turn" in `orchestration.md`. When
the queue empties, follow the empty-queue procedure exactly. Readying tickets is real work, and claiming "nothing left" is
the most common failure of this mode.

Follow-ups from swept tickets go through `followup.sh --parent <ticket>`. A
separate unrelated bug goes through `followup.sh --triage`.

## Finish

On the cycle's last day, run `issues.md`, Cycle closeout, for tickets this sweep
touched. Then post: delivered, carried, parked, issues created vs closed
(`issues.log`), incidents, and open human actions. Leave `STATE.md` complete
enough for the next sweep to start from.
