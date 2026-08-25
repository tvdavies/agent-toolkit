---
name: fleet-status
description: Summarise the central Dispatch board, active waits, stage ownership, and work requiring Tom without invoking agent heartbeats.
---

# Fleet Status

Answer what the fleet is doing and what needs Tom using Docket as the source of
truth. Do not run the legacy `jobctl` or `dispatchd` commands.

## Steps

1. Run `docket list --json` in the Dispatch workspace.
2. For tasks in `plan`, `implement`, `validate`, `review`, or `human_review`,
   read `docket show TASK --json` as needed for active waits, references, and
   latest activity.
3. Report in this order:

### Needs Tom

Include:

- `human_review` tasks;
- waits of kind `plan_feedback`, `scope_decision`, or `human_merge`; and
- failed wakes whose latest activity requests human intervention.

Show task ID, concise reason, and the plan/PR reference. Say "Nothing waiting on
you" when empty.

### In flight

Group non-waiting work by `plan`, `implement`, `validate`, and `review`. Show
assignee, selected `project:<key>` label (or `non-repository`/missing), active
session when `active_sessions` is non-empty, and most recent meaningful
activity. An active stage with no attached session is queued or anomalous, not
proof that an agent is currently working. `todo` is holding work, not in flight.

### External waits

List token-free waits such as `github_pr_change` that do not currently require
Tom.

### Anomalies

Only mention contradictory state: active stage without assignee, multiple or
missing canonical references, a stale session with no handoff, or a wait whose
reference no longer exists. Do not infer health from heartbeat timestamps;
Dispatch has no agent heartbeat.

Keep the report compact and include the local board URL.
