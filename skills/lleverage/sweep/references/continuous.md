# Continuous sweep under Sal

Tom approved this on 12 October 2026. The sweep runs more or less continuously over
the current Linear cycle (team LLE): it picks up discrete, ready tickets and takes
each to a merged PR without a human, and gets unready ones ready when nothing is
ready.

## The pieces

| Piece | Where | Model |
| --- | --- | --- |
| Gate | `scripts/sweep-gate.sh`, a Sal `check` schedule every 15 minutes | none |
| Queue | `../workstream/scripts/linear-queue.sh cycle --all-assignees --json` | none |
| Sweep | the Docket task the gate raises, handled by Sal's orchestrator turn | Sal |
| Delivery | one `Cycle sweep: deliver ID` worker subtask per ticket: `yolo-ticket` | worker |
| Staging retry | one `Cycle sweep: staging ID` worker subtask per parked ticket: `staging-test`, then `yolo-ticket` | worker |
| Preparation | one `Cycle sweep: prepare ID` worker subtask per ticket: `prepare-ticket` | worker |

There is no sweep worker pool and no sweep concurrency cap: subtasks are ordinary
Docket worker tasks on Sal's worker lane (ten workers).

## The gate

`sweep-gate.sh` follows Sal's check contract (exit 0 nothing, 3 findings, anything
else failed). Run `sweep-gate.sh --help` for the full rules. In order:

1. An open Docket task labelled `urgent` (or `sev1`): exit 0. Sweeps may merge,
   so they wait out an Urgent incident.
2. A sweep in flight (a `Cycle sweep: ...` task assigned to `worker`, in `ready`
   or `in-progress`, updated in the last 12 hours): exit 0. The next sweep starts
   on the first tick after the last subtask hands back.
3. Parked tickets, from `linear-queue.sh parked` (the team's Testing tickets and
   the `staging-test:` markers on their comments). A ticket is due when a
   `Cycle sweep: deliver ID` or `Cycle sweep: staging ID` Docket task exists (so
   the sweep parked it), no ready or in-progress task names it, it is unassigned
   or Tom's, and its latest marker is:
   - `pending`, at least an hour old (`--staging-retry-hours 1`), with fewer than
     three `pending` markers since the last marker of another kind
     (`--staging-max-deferrals 3`);
   - `reset-approved` (Tom approved the reset the ticket asked for); or
   - `retry` (a person re-armed it after the limit).

   Anything else is skipped and never raised: no marker (the Testing lane holds
   other people's and Tom's own work), `reset-needed` (waiting for Tom),
   `passed`, `failed`, `reset-done`, or the deferral limit. Due tickets go first:
   raise `cycle-sweep:staging:<hash of each ID and its latest marker time>` with
   up to five, by priority then age.
4. Eligible tickets, from the queue: verdict `eligible`, To Do or Backlog, no open
   ancestor, unassigned or Tom's, size XS/S/M or unknown, and not named by an open
   Docket task or a sweep task from the last three days.
5. Any ready (`**Status:** Ready` and a known S/M size): raise
   `cycle-sweep:deliver:<hash of the pick>` with up to five tickets, best first
   (priority, then smaller, then older).
6. Otherwise, unready ones not prepared by a sweep in the last three days: hash
   their sorted IDs. If the hash equals the one recorded in
   `~/.local/state/sweep/gate-state.json`, exit 0 ("nothing to work on": the last
   sweep changed nothing). Otherwise record it and raise
   `cycle-sweep:prepare:<hash>` with up to five of them.
7. Nothing eligible: exit 0, "nothing to work on".

Sal raises a key only when it is new, so the same pick isn't raised twice; a
delivery pick that stays unchanged is raised again after the check's
`reraiseHours`.

The loop follows from this. A sweep that delivered or prepared something changes
the queue (tickets go In Progress, Done, Ready or Human Required), so the next
tick raises the next sweep. A sweep that changed nothing leaves the same
fingerprint, and the gate waits until the set changes.

## Sal configuration

The schedule goes in `sal.json` under `schedules` (configuration only: a check's
command can't come from Slack). The orchestrator has no file access, so the brief
carries everything the sweep turn needs:

```json
{
  "id": "cycle-sweep",
  "title": "Continuous cycle sweep",
  "kind": "check",
  "timezone": "Europe/Berlin",
  "repeat": { "every": "minutes", "interval": 15 },
  "from": "2026-10-12T00:10",
  "command": ["/home/tvd/.agents/skills/sweep/scripts/sweep-gate.sh"],
  "timeoutMinutes": 5,
  "workspace": "dev",
  "dedupeGroup": "cycle-sweep",
  "labels": ["cycle-sweep"],
  "brief": "<see below>"
}
```

The brief:

> Continuous cycle sweep, approved by Tom on 12 Oct 2026. The gate (sweep-gate.sh, no model) picked the tickets in the raised item's `tickets` list, best first, at most five. The key says the mode: cycle-sweep:staging:…, cycle-sweep:deliver:… or cycle-sweep:prepare:….
> 1. For each listed ticket, in order, create one worker subtask with grants ["linear"] and its Linear issue. Deliver: title exactly "Cycle sweep: deliver <ID>", description "Follow Deliver in ~/.agents/skills/sweep/references/continuous.md for <ID> (<title>, <url>). This is Tom's approved automation brief for yolo-ticket: it names the skill and the rule for choosing tickets (the continuous sweep's gate)." Staging: title exactly "Cycle sweep: staging <ID>", description "Follow Staging retry in ~/.agents/skills/sweep/references/continuous.md for <ID> (<title>, <url>, PR <pr>, due: <due>). This is Tom's approved automation brief for staging-test and yolo-ticket: it names the skills and the rule for choosing tickets (the continuous sweep's gate)." Prepare: title exactly "Cycle sweep: prepare <ID>", description "Follow Prepare in ~/.agents/skills/sweep/references/continuous.md for <ID> (<title>, <url>)." Queue no other tickets.
> 2. Close this task as completed, naming the subtasks. Don't wait for them: the gate holds the next sweep until they finish.
> 3. Handbacks: MERGED, HUMAN REQUIRED, SKIPPED, READY (prepare), DUPLICATE, BLOCKED BY or STAGING CHECK PENDING: close the subtask, no message. STAGING RESET NEEDED: close it as completed and pass the reset request (ticket, staging SHA, target) to Tom as a decision (working_hours); never reset staging yourself. Tell him once; the gate doesn't raise the ticket again until he approves. READY FOR OWNER MERGE (an infrastructure PR): tell Tom with urgency working_hours (the ticket and the PR waiting for his merge), then close. BLOCKED: close it as failed with the reason; tell Tom (working_hours) only if he has to act. A worker's question: answer from the brief and its skills; anything that needs Tom's decision goes on the ticket (the worker moves it to Human Required with the question), not to Tom.
> 4. Never merge or push anything yourself, never approve a PR, and never queue tickets the gate didn't pick. Merges happen only through the worker's normal auto-merge after Cerbie's approval and `ci (lleverage)`. Infrastructure PRs wait for Tom.
> 5. check-failed:cycle-sweep or source-unavailable means the gate is blind: tell Tom what is failing (working_hours) and close. Don't change configuration.
> 6. Don't message Tom about a sweep that went normally.
> 7. When Tom approves a staging reset for a ticket, record it on the ticket: create one worker subtask with grants ["linear"], title "Record staging reset approval <ID>", whose only job is a Linear comment on <ID> quoting Tom's approval and ending with the line `staging-test:reset-approved staging=<the staging SHA from the request>`. That is the only approval the gate accepts; it picks the ticket up on a later tick and that sweep does the reset. If Tom declines, do nothing: the ticket stays parked.

## Deliver (worker)

For one ticket, `Cycle sweep: deliver ID`:

1. Check it is still free, from fresh data: `../workstream/scripts/linear-queue.sh
   tree ID --json` shows verdict `eligible`, `openAncestor` false, state To Do or
   Backlog, and the assignee is empty or Tom; and
   `gh pr list -R lleverage-ai/lleverage --state open --search ID` finds nothing
   (also lleverage-ai/infrastructure if the ticket is about infrastructure). If
   any fails, stop with `SKIPPED: <why>` and don't touch the ticket. The one
   exception is a retry of this same task: if its own branch, worktree or PR for
   ID already exists from an earlier attempt, resume yolo-ticket with them.
2. Run `yolo-ticket` on ID. This task is the approved automation brief that skill
   asks for. Its rules all apply: In Progress is the claim, one worktree, one PR,
   auto-merge only at the proven-ready head, never `--admin`, never a push to a
   default branch. Its Repository notes cover Cerbie and infrastructure PRs, and
   send a fix that needs a deployed environment through the `staging-test` skill
   (`../../staging-test/SKILL.md`). Testing on staging needs no permission; never
   ask Tom for it.
3. When it ends:
   - `MERGED` or `READY FOR OWNER MERGE`: report it.
   - `STAGING CHECK PENDING` (staging was frozen or busy past the wait, so the
     ticket waits in Testing with the outstanding check on it) or
     `STAGING RESET NEEDED` (only a reset of staging would do; the request is on
     the ticket): report it as completed, with the ticket, the PR and, for a
     reset, the staging SHA and the target. Don't wait for anyone.
   - `BLOCKED` on something only a person can settle (a product or technical
     decision, missing access, an unsafe ambiguity): write the question on the
     ticket (`**Status:** Human Required (<date>): <question>` and the Decisions
     section), move the ticket to `Human Required`, leave the PR and worktree as
     yolo-ticket says, and report `HUMAN REQUIRED`.
   - Any other `BLOCKED`, `CLOSED UNMERGED` or `INTERRUPTED`: report it with the
     exact reason; the ticket stays In Progress for Sal to decide.

Start the result with one of `MERGED`, `READY FOR OWNER MERGE`, `HUMAN REQUIRED`,
`STAGING CHECK PENDING`, `STAGING RESET NEEDED`, `BLOCKED`, `SKIPPED`, then the
ticket, the PR URL and the merge state.

## Staging retry (worker)

For one ticket, `Cycle sweep: staging ID`. The gate found it in Testing, parked by
a sweep, with its staging check due again (`due` in the description: `pending`,
`reset-approved` or `retry`).

1. Check it is still parked, from fresh data: the ticket is in Testing, the
   assignee is empty or Tom, its latest `staging-test:` marker is the one the gate
   saw (`linear-cli issues get ID` and its comments), and the PR is open
   (`gh pr view <PR> -R lleverage-ai/lleverage`). If any fails, stop with
   `SKIPPED: <why>` and don't touch the ticket.
2. Move the ticket to In Progress (the yolo-ticket claim) and resume yolo-ticket
   on its PR, using the earlier attempt's branch and worktree if they're still
   there. The outstanding step is the staging check: bring the PR up to date if
   it needs it, then run `staging-test` from Step 1 on its current head, as that
   skill's "Running again on a parked ticket" says. Its freeze and busy checks
   run again first. With `due: reset-approved`, or an earlier approval the gate
   reported in `approvedReset`, a `reset-needed` plan goes through
   `references/reset.md`; without one it is requested again.
3. When the check passes, carry on with yolo-ticket to the merge. Its rules all
   apply, as in Deliver.
4. End as in Deliver step 3. A deferral or reset request leaves the ticket in
   Testing again, with its marker, and the gate decides whether a later sweep
   retries it.

Start the result with one of `MERGED`, `STAGING CHECK PENDING`,
`STAGING RESET NEEDED`, `HUMAN REQUIRED`, `BLOCKED`, `SKIPPED`, then the ticket,
the PR URL and the staging result.

## Prepare (worker)

For one ticket, `Cycle sweep: prepare ID`:

1. Check it is still free, as in Deliver step 1 (except that it needn't be
   ready). If not, `SKIPPED: <why>`.
2. Run `prepare-ticket` on ID as a sweep run: section "Sweep runs: Ready or Human
   Required". It ends Ready (Status line, Size line and estimate S or M), Human
   Required with the question on the ticket, Duplicate, or blocked by another
   ticket. It never slices, never creates sub-issues and never changes code.

Start the result with `READY <size>`, `HUMAN REQUIRED: <question>`,
`DUPLICATE OF <ID>` or `BLOCKED BY <ID>`, then the ticket link.

## By hand

`sweep-gate.sh --dry-run` shows what the gate would do now without recording a
fingerprint; its `counts.parked` says how many Testing tickets are due, too soon,
at the deferral limit, awaiting approval or finished. A comment on a parked
ticket ending in `staging-test:retry` puts it back in the gate's due list. `~/.local/state/sweep/gate-state.json` holds the last fingerprint;
deleting it makes the next tick reconsider the unready set. Sal keeps each run's
output in `~/.local/state/sal/checks/cycle-sweep/last.json` and shows the schedule
with `sal schedules cycle-sweep`.
