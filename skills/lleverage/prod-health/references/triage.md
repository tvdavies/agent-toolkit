# Severity and response

## Grading

Grade by customer impact. A big count on its own doesn't make something severe.

Severity uses Linear's issue priority names, so the grade is the ticket's
priority: **Urgent** (1), **High** (2), **Medium** (3), **Low** (4). Machine
values are lower case (`urgent`, `high`, `medium`, `low`). Never write
SEV1/SEV2/SEV3 or "Critical" in tickets or results.

| Severity | Typical signals | Examples |
|---|---|---|
| **Urgent** (p1) | Customer-facing outage or data loss. Failures across many orgs (5 or more) in a platform category. A crashloop or stuck rollout of a core service (`app`, `workflow-service`, `session-service`, `agent-service`, `credential-service`, `actions-gateway`, NATS, Redis). PostHog pageviews collapse or exceptions appear on every public app. A deploy build failing on the newest commits, so fixes can't ship. A critical alert for a customer path. | #7395: every public workflow app crashed in the browser for ~15h. Cloud Build failing for `app` on the last two main commits. |
| **High** (p2) | A real regression affecting some customers or degrading a feature. A new error signature after a deploy. 5xx on a service. A 401/403 storm on one route. A jump in `platform_error`, `platform_interrupted` or `api_execution_uncertain`. Stuck dispatches. Sentry or PostHog going quiet (lost observability). | LLE-13962: every anonymous poll of `/api/public/workflow-session` returned 401. The app's Sentry stopped reporting after a build change. |
| **Medium** (p3) | A confirmed real defect with limited impact: a feature broken for a few users with a workaround, not a regression across customers. | One integration action failing for a handful of users who can retry another way. |
| **Low** (p4) | Low impact. One org's own workflow or integration failing (`upstream_rejected`, `script_error`). Known noise drifting. Warn-volume changes. A non-critical alert that isn't new. | A customer's HTTP node getting 403 from their endpoint. |

Hints from the scripts (`urgent`, `high`, `low`, rarely `medium`) come from simple
rules: core namespace, number of orgs affected, status class, and whether the series
is new. Medium is mostly a grade you give after confirming a defect, not a script
hint. Override hints with judgement, and say why when you do. Older outputs and
watch state may still say `sev1`, `sev2` or `sev3`; read them as `urgent`, `high`
and `low`.

Recurring slots (`references/baselines.md`): a burst listed under `recurring`
(`-- recurring slot, not raised:` in the text report) came at its usual local
time and was no bigger than the slot allows, so it needs no grade and no ticket.
A raised finding whose title says `above recurring slot …` is the same key in its
slot but larger than any burst it was learned from: treat it as a possible real
incident. Compare the count with the slot's `seen` counts in its evidence, and
check whether the failures are the usual ones (the same orgs, nodes and error
messages) or new. A key that keeps bursting at the same local time on most days
but has no slot is a candidate for `slot learn` once Tom agrees, not for
`accept`.

Attribution: a finding's `deployed in window` candidates are rollouts in the
same namespace (org namespaces map to `workflow-service`), then the most recent
others. Check chronology: the signal should start after the rollout (re-run with
`--end` just before the deploy to compare). A regression from our change goes on
the ticket that caused it (`--parent`).

## Response

In an unattended run (a worker or scheduled run that can't message Tom), don't
use PushNotification or Slack: follow **Unattended runs** in `SKILL.md`, which
returns the Urgent or High finding to the caller with a rollback recommendation and a
fix-forward plan, and add `-l Sal` to every `followup.sh` call that creates a
ticket. The steps below are for an attended session.

**Urgent**

1. Stop merging. Pause auto-merge on your open PRs (`gh pr merge --disable-auto`) and
   tell other running sessions if you can.
2. Notify Tom straight away with PushNotification (Slack DM via the `slack` skill if
   that isn't available). Include the symptom, impact (orgs by name, users, counts),
   start time, suspected deploy and PR, and your recommendation.
3. Recommend one of:
   - **Roll back** when the cause is a recent deploy and isn't trivially fixable.
     ROLLBACK HOOK: use the `rollback` skill once it exists. Until then, give the
     previous image tag (`from` in the `deploys` line) and the PR to revert, and wait
     for Tom's approval. Don't roll back or merge a revert yourself without it.
   - **Fix forward** when the cause is understood and the fix is small and quick to
     ship (one PR, low risk), and the deploy pipeline works.
4. File the Linear bug at priority 1 (below). Keep checking at a 10-minute window
   until it recovers, then verify and close the loop.

**High**

1. Confirm the signal and dedupe it.
2. Create the bug: `followup.sh -p 2 --triage "<title>" -d "<body>"`. Use
   `--parent <ticket>` instead of `--triage` when a change from this run caused it.
3. If it is ready (reproducible, cause located, fix scoped,
   acceptance clear), start it now with `yolo-ticket`. Otherwise leave it in Triage
   with the evidence attached.

**Medium and Low**

- Real defect: `followup.sh --triage -p 3 "<title>" -d "<body>"` for Medium,
  `-p 4` for Low. No message to Tom.
- Normal behaviour, confirmed by a human: `baseline.sh accept <key> --note "<why>"`.
- Unsure: mention it in the report and let it run another tick.

## Linear ticket

Follow "Writing tickets" in `../../workstream/references/issues.md`. The title
names the symptom as a user would see it, in a few words, with no priority or
severity word in front (`Public workflow apps crash on load`, not `Urgent: public
workflow apps crash on load`). The ticket's Linear priority field carries the
severity, so don't repeat it in the title or add a separate severity label. The
description stays short:

```markdown
## Problem
<what is failing, as a user would see it>. <who, how many orgs, what breaks>.
Started <first seen>, after <from→to, PR #…, LLE-…>.

## Next step
<revert / fix-forward idea / investigate with root-cause>

Evidence: [<ID> prod-health evidence](<Linear document URL>)
```

Put the evidence in a Linear document on the issue
(`bash ~/.claude/skills/linear-cli/scripts/issue-document.sh ID evidence.md -T "ID prod-health evidence"`):

```markdown
**prod-health, <env>, <start>–<end> UTC**
- <signal>: <count> in <window> vs baseline <rate>/h (<ratio>x) — key `<finding key>`
- Organisations: <Name (org-short)>, … (<n> total)
- Query: `<LogQL / SQL / HogQL from the finding>`
- Deploys in the window: <from→to, PR #…>
```

`followup.sh` creates the ticket first, so attach the document straight after and
add its link to the description. Never paste secrets, database URLs or customer
payloads, and never use files.myslop.app or another public host for evidence.
Session and org ids are fine.
