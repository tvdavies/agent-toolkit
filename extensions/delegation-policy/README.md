# Delegation policy

This extension appends delegation guidance in `before_agent_start`. It is prompt
policy, not a shell-command parser or runtime permission gate.

## Approved routes

- `subagent`: focused delegated work.
- `workflow_run`: orchestrated work under its own execution policy.
- Dispatch/Docket: explicitly requested fleet work through the installed
  Dispatch skill, plus an assigned Dispatch worker's own stage transitions.

Dispatch's documented Docket lifecycle commands run through `bash` against the
configured central workspace. A move into `plan`, `implement`, or `review` can
assign and wake an agent through the phase-entry hook. That side effect is the
intended managed handoff, not an ad hoc agent CLI launch. Documented wait/resume
operations can also wake the assigned stage owner.

The exception does not grant permission to skip dependencies, resolve waits
without authority, bypass current-version human approval, claim another task,
assign agents manually, change hooks, or invoke `dispatch-wake`, adapters,
engine endpoints, or agent CLIs directly. Dispatch is not a fallback around a
denied or failed delegation route. Other workflow and stage restrictions still
apply.

Creating a holding task in `todo` and inspecting the board do not launch agents.
A successful status update alone is not proof of launch: inspect the handler
event before reporting that an agent started.

## Updating the installed policy

The Agent Toolkit local Pi package loads this file from its installed checkout.
After applying a change there, run `/reload` in each affected cockpit session or
restart Pi. New Dispatch worker sessions load the updated extension; an existing
worker must reload or restart before relying on it. Editing the source does not
change the instructions already in force in a running turn.

No provider settings, Docket hooks, task statuses, or launch code need to change
for this policy correction. An upstream HTTP 520 followed by the local proxy's
429 `model_cooldown` is a separate provider-availability failure.

## Validation

```sh
bun test ./extensions/delegation-policy/index.test.ts
```

These tests check prompt injection, deduplication, and the wording of the
Dispatch exception and remaining boundaries. They do not run Pi, call a model,
mutate Docket, or prove an end-to-end fleet launch.
