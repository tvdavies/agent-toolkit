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
3. Eligible tickets, from the queue: verdict `eligible`, To Do or Backlog, no open
   ancestor, unassigned or Tom's, size XS/S/M or unknown, and not named by an open
   Docket task or a sweep task from the last three days.
4. Any ready (`**Status:** Ready` and a known S/M size; `**Status:** Ready from
   <date>` counts only from that date, and until then, or if the date can't be
   read, the ticket is listed as waiting and neither delivered nor prepared): raise
   `cycle-sweep:deliver:<hash of the pick>` with up to five tickets, best first
   (priority, then smaller, then older).
5. Otherwise, unready ones not prepared by a sweep in the last three days: hash
   their sorted IDs. If the hash equals the one recorded in
   `~/.local/state/sweep/gate-state.json`, exit 0 ("nothing to work on": the last
   sweep changed nothing). Otherwise record it and raise
   `cycle-sweep:prepare:<hash>` with up to five of them.
6. Nothing eligible: exit 0, "nothing to work on".

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

> Continuous cycle sweep, approved by Tom on 12 Oct 2026. The gate (sweep-gate.sh, no model) picked the tickets in the raised item's `tickets` list, best first, at most five. The key says the mode: cycle-sweep:deliver:… or cycle-sweep:prepare:….
> 1. For each listed ticket, in order, create one worker subtask with grants ["linear"] and its Linear issue. Deliver: title exactly "Cycle sweep: deliver <ID>", description "Follow Deliver in ~/.agents/skills/sweep/references/continuous.md for <ID> (<title>, <url>). This is Tom's approved automation brief for yolo-ticket: it names the skill and the rule for choosing tickets (the continuous sweep's gate)." Prepare: title exactly "Cycle sweep: prepare <ID>", description "Follow Prepare in ~/.agents/skills/sweep/references/continuous.md for <ID> (<title>, <url>)." Queue no other tickets.
> 2. Close this task as completed, naming the subtasks. Don't wait for them: the gate holds the next sweep until they finish.
> 3. Handbacks: MERGED, HUMAN REQUIRED, SKIPPED, READY (prepare), DUPLICATE or BLOCKED BY: close the subtask, no message. READY FOR OWNER MERGE (an infrastructure PR): tell Tom with urgency working_hours (the ticket and the PR waiting for his merge), then close. BLOCKED: close it as failed with the reason; tell Tom (working_hours) only if he has to act. A worker's question: answer from the brief and its skills; anything that needs Tom's decision goes on the ticket (the worker moves it to Human Required with the question), not to Tom.
> 4. Never merge or push anything yourself, never approve a PR, and never queue tickets the gate didn't pick. Merges happen only through the worker's normal auto-merge after Cerbie's approval and `ci (lleverage)`. Infrastructure PRs wait for Tom.
> 5. check-failed:cycle-sweep or source-unavailable means the gate is blind: tell Tom what is failing (working_hours) and close. Don't change configuration.
> 6. Don't message Tom about a sweep that went normally.

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
   default branch. Its Repository notes cover Cerbie and infrastructure PRs.
3. When it ends:
   - `MERGED` or `READY FOR OWNER MERGE`: report it.
   - `BLOCKED` on something only a person can settle (a product or technical
     decision, missing access, an unsafe ambiguity): write the question on the
     ticket (`**Status:** Human Required (<date>): <question>` and the Decisions
     section), move the ticket to `Human Required`, leave the PR and worktree as
     yolo-ticket says, and report `HUMAN REQUIRED`.
   - Any other `BLOCKED`, `CLOSED UNMERGED` or `INTERRUPTED`: report it with the
     exact reason; the ticket stays In Progress for Sal to decide.

Start the result with one of `MERGED`, `READY FOR OWNER MERGE`, `HUMAN REQUIRED`,
`BLOCKED`, `SKIPPED`, then the ticket, the PR URL and the merge state.

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
fingerprint. `~/.local/state/sweep/gate-state.json` holds the last fingerprint;
deleting it makes the next tick reconsider the unready set. Sal keeps each run's
output in `~/.local/state/sal/checks/cycle-sweep/last.json` and shows the schedule
with `sal schedules cycle-sweep`.
