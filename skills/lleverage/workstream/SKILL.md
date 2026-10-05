---
name: workstream
description: Autonomously drive one top-level Linear issue to done. Plans it, slices it into ready sub-issues, then delivers them through parallel yolo-ticket subagents with one PR watcher, staged rollout, prod health checks and disciplined follow-ups, until every descendant is done and verified. Use only when the user explicitly invokes /workstream with an issue ID, or explicitly asks to run a workstream or project on a named top-level issue. Grants the per-ticket merge authority of yolo-ticket for that issue's descendants only.
compatibility: Requires git, GitHub CLI, jq, linear-cli, kubectl access per the prod-health-check-access memory, and the yolo-ticket, start-ticket and babysit-pr skills.
disable-model-invocation: true
metadata:
  author: tvd
  version: 1.0.0
---

# Workstream

Own one top-level issue (`ROOT`) and everything beneath it until it is done:
merged, deployed, verified and accepted. You are the orchestrator. Implementer
subagents write the code. Read these before starting, and again after a compaction:

- `references/orchestration.md`: state, the loop, capacity, the PR watcher,
  the human queue, the empty-queue procedure, and communication
- `references/issues.md`: readiness, planning, slicing, follow-ups, done, closeout
- `references/merge-and-review.md`: merge policy, review economics, main health
- `references/verification.md`: health ticks, smoke tests, staged rollout, incidents
- `references/implementer-brief.md`: the brief every implementer follows

Scripts are in `scripts/` (run with `--help`): `linear-queue.sh`, `pr-ledger.sh`,
`followup.sh`, `prod-health.sh`.

## Arguments

Exactly one issue identifier (`^[A-Z][A-Z0-9]*-[0-9]+$`, normalised to upper case).
Any other text is extra mandate: scope, stop condition, or constraints. If none is
given, the stop condition is "every open descendant and ROOT are Done, the rollout
is verified, and production is healthy".

## Phase 0: claim and set up

1. Read `ROOT` and its tree: `scripts/linear-queue.sh tree ROOT --include-closed`.
2. **Ownership.** If `ROOT` or any ancestor is already in a started state and this
   session didn't start it, another session may own it. Look for open PRs and
   worktrees from other sessions. If it is ambiguous, ask Tom once before
   proceeding.
3. **Claim:** set `ROOT` to In Progress, assigned to Tom. This is the only claim
   signal. `/sweep` sessions skip every descendant of a started issue. Keep `ROOT`
   In Progress for the whole run. Track parents inside the tree also move to In
   Progress while their children are being worked.
4. Create `WS_DIR=~/.local/state/workstreams/<root-id-lowercase>` and write
   `STATE.md` with the mandate, the stop condition and the exclusions. Exclusions
   cover other sessions' trees and shared resources owned elsewhere, such as SDK
   releases.
5. Read `MEMORY.md` for active temporary exceptions and environment notes. Write
   `brief.md` from the template.
6. Capture `baseline-health.txt`. Start the PR watcher Monitor.
7. Settle authority questions in **one** message to Tom: staging promotion, infra
   changes, and whether production flags for this programme may be proposed. Then
   don't ask again.

## Phase 1: understand and plan

Follow `issues.md`, Planning a top-level issue: inventory what exists, bring
decisions to Tom as options with their costs, spike the riskiest seam, and write
invariants as tests. Use read-only investigators (`sol-investigator`,
`sol-evidence`) in parallel, each with one bounded question. Write the design up
(a Linear document linked from ROOT) when the change spans services or contracts.

Ask for decisions only when they are Tom's to make. Answer your own open questions
by investigating.

## Phase 2: slice and ready

Create sub-issues per `issues.md`, Slicing: value-sized slices, lanes for shared
files, few parents, `blocks` relations for real ordering, one owner per shared
resource. Create them with `scripts/followup.sh --parent <id>` (current cycle,
assigned to Tom, project inherited). Before bulk creation, show Tom the slice list
with lanes and the critical path in one message, unless the mandate already said
to proceed.

Work starts as soon as the first slices are ready. Readying the rest continues in
parallel.

## Phase 3: deliver

Run the loop in `orchestration.md`, using `linear-queue.sh tree ROOT` as the queue.
`eligible` tickets that meet the readiness bar go to implementers. Unready ones
go to `prepare-ticket` subagents. Read "Ending a turn" in `orchestration.md`
before the first dispatch: this mode is unattended, and stopping early is its
most common failure. Priority order: production-impacting fixes, then the
critical path, then the rest.

Throughout:

- After each merge, refresh the lane, verify the deploy, and wake dependants.
- Health tick after each deploy of our change.
- Follow-ups go through `followup.sh` and the order in `issues.md` (fold in first).
- Keep `STATE.md` current. It is the only memory that survives.

## Phase 4: roll out and verify

For risky changes, follow `verification.md`, Staged rollout. Soak ends and
deferred checks go in `STATE.md` under Next checks. A ticket whose acceptance is
"live and verified" stays open until it is.

## Phase 5: finish

The workstream is done when the stop condition holds:

1. Run `linear-queue.sh tree ROOT` and get nothing open, or only items Tom agreed
   to carry.
2. Close `umbrella-done` parents and ROOT, each with a short acceptance note.
3. Make sure the ledger is empty, no worktrees are dirty, and agents are stopped.
   Remove merged worktrees.
4. Post the summary: delivered, verified, carried or parked, issues created vs
   closed, incidents, and what's left for Tom.

At a cycle boundary mid-run, apply `issues.md`, Cycle closeout, to this tree only.

If the run must stop early (a decision is blocking the critical path, a usage cap,
an incident), write `STATE.md`, leave ROOT In Progress, and report the exact
resume point.
