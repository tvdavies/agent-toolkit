---
name: dispatch
description: Create and explicitly start one autonomous Dispatch task from the cockpit. Use when Tom says dispatch, send this to the fleet, or asks the fleet to plan, implement, validate, or review named work.
---

# Dispatch

Capture one unit of work in the central Docket workspace and explicitly move it
from `todo` into its first active stage. Do not perform the dispatched work in
the cockpit session.

For Linear-backed intake, load the installed `linear-cli` skill by name and follow its complete issue, comment, attachment, screenshot, and recording retrieval process. Load the installed `writing-for-humans` skill by name for intake comments or updates that will be read by people.

## Workflow

The normal delivery path is:

```text
todo → plan → implement → validate → review → human_review → done
```

Creation in `todo` never wakes an agent. The cockpit's final move is the
explicit dispatch event.

## 1. Resolve the target

Accept one clear target:

- ticket identifier and URL;
- pull-request number or URL; or
- a well-bounded free-text task.

Reject ambiguous multiple targets. For repository-backed work, determine the
source project from conversation context, structured references, and
`fleet.yaml`; do not default to any particular project or guess when it changes which code
will be modified. A bounded non-repository task may omit a project.

## 2. Write the intake

Capture durable context the autonomous stages should not rediscover:

- desired outcome and acceptance criteria;
- constraints and decisions already agreed;
- relevant files, systems, links, screenshots, or prior work;
- approaches explicitly ruled out;
- scope boundaries and human-only decisions; and
- any known urgency or risk.

Use concise Markdown. Do not pad an empty intake.

## 3. Create the holding task

Run against the central Dispatch workspace:

```sh
TASK_ID=$(docket new \
  --title "Concise outcome" \
  --status todo \
  --label "project:PROJECT_KEY" \
  --desc-file "$INTAKE_FILE")
```

Use the `project:<key>` label only when `PROJECT_KEY` exists in `fleet.yaml`.
Omit it for a non-repository task. When repository identity genuinely cannot be
resolved during intake, dispatch to `plan` without a project label and state the
ambiguity explicitly; the planner must resolve and record it before handoff.

```sh
# Non-repository or intentionally planner-resolved intake
TASK_ID=$(docket new \
  --title "Concise outcome" \
  --status todo \
  --desc-file "$INTAKE_FILE")
```

Add machine-readable source links rather than burying them only in prose:

```sh
docket reference add "$TASK_ID" --kind ticket --url "$TICKET_URL" --title TEAM-123
# or
docket reference add "$TASK_ID" --kind pr --url "$PR_URL" --title "Existing pull request"
```

Verify with `docket show "$TASK_ID" --json`.

## 4. Explicitly dispatch

Use `plan` when investigation, technical design, or human approval is still
needed:

```sh
docket move "$TASK_ID" plan
```

An explicit `implement` start is permitted when the Docket intake or an
authoritative source reference already contains a bounded outcome, acceptance
criteria, and enough implementation direction to proceed without inventing a
material product or architecture decision. Retrieve the complete referenced
ticket before choosing this bypass; a ticket identifier or title alone is not
enough.

For an existing complete draft PR that only needs independent validation, an
explicit `validate` start is permitted. For an already-ready PR that only needs
feedback/CI driving, `review` is permitted. Explain every bypass in the intake;
do not skip stages merely to save time.

The phase-entry hook owns assignment and agent waking. Do not assign manually.

## 5. Confirm

Return one concise line containing:

- task ID and title;
- initial active stage;
- source reference;
- selected project key, `planner to resolve`, or `non-repository`; and
- local board URL.

Do not claim an agent has started unless the Docket handler event confirms it.
There is no heartbeat or time-based queue scan.
