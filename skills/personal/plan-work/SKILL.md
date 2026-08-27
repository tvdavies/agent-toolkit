---
name: plan-work
description: Investigate a bounded task and produce a human-approved implementation plan on plans.myslop.app before any code is written. Use when the user asks to "plan this", "write up a plan", "produce a design doc", "propose an approach for review", or wants explicit approval before implementation begins.
compatibility: Requires bash, curl, jq, network access to plans.myslop.app, and the installed plan-review skill.
---

<!-- Canonical copy. The Dispatch repo vendors this skill at
     dispatch/skills/plan-work; keep them in step. -->

# Plan Work

Turn one bounded piece of work into an implementation-ready, human-approved
plan. Planning is read-only: no source changes, no feature branch, no worktree
created merely to investigate.

## Shared mechanics

Load the installed `plan-review` skill by name. Its `plan.sh` script owns every
plan-service call — publish, status, comments, replies, resolution, revisions —
and resolves the API token itself, failing with the exact remedy when the token
is missing or invalid. Never hand-roll curl calls, token checks, or
pre-verification; run the command you need and surface its error verbatim.

## Dispatch integration

When `DISPATCH_TASK_ID` is set, the `plan-ticket` stage skill is the driver: it
owns task loading, project resolution, Docket references and comments, the
seeded `plan_feedback` wait, and the approval handoff. Inside a Dispatch wake,
use this skill only for its investigation methodology and document shape —
never poll the service and never stop to wait for review; `plan-ticket`
records one wait and exits.

## 1. Scope one target

Accept one clear target: a ticket, feature, refactor, bug, migration, or a
decision that needs a written proposal. Gather its authoritative sources first
— the full ticket text and attachments, linked PRs or prior work, and any
constraints already agreed in conversation.

If a material product decision prevents a coherent plan, ask the decision as a
focused question instead of guessing. Do not pad ambiguity into confident
prose.

## 2. Investigate — read-only

In the target repository or system:

1. read `AGENTS.md`, `CLAUDE.md`, and scoped guidance files;
2. inspect the current implementation, comparable existing patterns, tests,
   and recent relevant changes;
3. identify producers and consumers of every contract the change touches;
4. reproduce or trace current behaviour where practical;
5. separate verified facts from assumptions and label them as such; and
6. choose the narrowest complete implementation that satisfies the target.

## 3. Write the plan

Write Markdown that lets a human decide quickly and an implementer act without
rediscovering the design.

Principles:

- Lead with the decision and target behaviour, not the investigation diary.
- Prefer one recommended approach; put rejected alternatives and reasons in a
  compact decision table.
- Keep altitude proportional to blast radius: exact contracts and sequencing,
  not line-by-line edits an implementer can discover safely.
- Every implementation step is one bounded deliverable with an observable
  completion condition and explicit validation.
- Turn uncertainty into an explicit open question or a validation step.
- Link source evidence: tickets, code, API documentation, prior decisions.
- Cover persisted data, APIs, events, permissions, compatibility, rollout, and
  recovery whenever the change touches them. Write "No contract change" only
  after checking.

Required shape:

```markdown
# <Outcome-oriented title>

> **Source:** <ticket/PR/context> · **Plan version:** N

## Decision summary
What will change, why this approach, what deliberately will not change.

## Goals and non-goals

## Current state
Only facts needed to understand the change.

## Target design
Components, boundaries, data flow, failure behaviour, user-visible behaviour.

## Contracts and compatibility

## Implementation sequence
### Step 1 — <bounded deliverable>
- scope and intended files/components
- behaviour and constraints
- validation proving completion

## Validation

## Rollout and recovery

## Risks and decisions
Compact table: risk/decision, mitigation/rationale, owner if external.

## Open questions
Only questions that truly require human input. Prefer none.
```

Follow the `plan-review` authoring constraints: the service renders a bounded
Markdown subset (no raw HTML, no setext headings), and every top-level block is
an individually commentable anchor — one idea per paragraph or list item, and
keep unchanged blocks word-stable across versions. For diagrams, export
SVG/PNG, upload with the file-upload skill, and embed the `files.myslop.app`
URL as a Markdown image; prefer text and tables unless a diagram genuinely
makes the argument.

Before publishing, verify: the title and version are current, every required
section is present, links are valid and credential-free, no source change or
secret is included, and the plan can be implemented without rediscovering a
hidden decision.

## 4. Publish and share

Publish with `plan.sh create --title "…" --md plan.md` and give the returned
`url` to the reviewer — that is where they read, comment on blocks, approve,
or request changes.

## 5. Wait for review — by context

- **Interactive session (default):** stop after sharing the URL. Do not burn
  turns polling while the human reads. Process feedback when they return, ask
  you to check, or explicitly ask you to wait — only then poll.
- **Autonomous, non-Dispatch:** poll `plan.sh status` every 30–60 s; act when
  `status` leaves `open` or new comments arrive.
- **Dispatch wake:** never wait here — `plan-ticket` owns the seeded wait.

## 6. Iterate

For each round of feedback:

1. read `plan.sh status` and `plan.sh comments`;
2. reply in-thread (`plan.sh comment PLAN --body … --reply-to ID`); apply
   correct feedback by default, ask a focused question on a genuine tradeoff,
   and decline only with requirement- or code-grounded reasoning;
3. `plan.sh resolve` a thread only after actually addressing it in a reply or
   a revision;
4. when changes are needed, publish the full revised Markdown with
   `plan.sh revise PLAN --note "vN+1: …" --md plan.md`, including a short
   version changelog in the document; and
5. account for every feedback item — changed, answered, or declined with
   reasons. Batch feedback into one revision; do not micro-version.

## 7. Approved — hand off

Approval is the service's verdict, never your own assessment: proceed only
when `plan.sh status` shows `status` is exactly `approved` for the current
version. A new version resets approval.

Then hand off with the plan URL, the tokenless `raw_url` (readable by any
agent or tool), the approved version number, and the key decisions — whether
the implementer is you in this session, another agent or skill (for example
`start-ticket`), or a human.
