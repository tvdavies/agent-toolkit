# Severity and response

## Grading

Grade by customer impact. A big count on its own doesn't make something severe.

| Severity | Typical signals | Examples |
|---|---|---|
| **SEV1** | Customer-facing outage or data loss. Failures across many orgs (5 or more) in a platform category. A crashloop or stuck rollout of a core service (`app`, `workflow-service`, `session-service`, `agent-service`, `credential-service`, `actions-gateway`, NATS, Redis). PostHog pageviews collapse or exceptions appear on every public app. A deploy build failing on the newest commits, so fixes can't ship. A critical alert for a customer path. | #7395: every public workflow app crashed in the browser for ~15h. Cloud Build failing for `app` on the last two main commits. |
| **SEV2** | A real regression affecting some customers or degrading a feature. A new error signature after a deploy. 5xx on a service. A 401/403 storm on one route. A jump in `platform_error`, `platform_interrupted` or `api_execution_uncertain`. Stuck dispatches. Sentry or PostHog going quiet (lost observability). | LLE-13962: every anonymous poll of `/api/public/workflow-session` returned 401. The app's Sentry stopped reporting after a build change. |
| **SEV3** | Low impact. One org's own workflow or integration failing (`upstream_rejected`, `script_error`). Known noise drifting. Warn-volume changes. A non-critical alert that isn't new. | A customer's HTTP node getting 403 from their endpoint. |

Hints from the scripts (`sev1`, `sev2`, `sev3`) come from simple rules: core namespace,
number of orgs affected, status class, and whether the series is new. Override them
with judgement, and say why when you do.

Attribution: a finding's `deployed in window` candidates are rollouts in the
same namespace (org namespaces map to `workflow-service`), then the most recent
others. Check chronology: the signal should start after the rollout (re-run with
`--end` just before the deploy to compare). A regression from our change goes on
the ticket that caused it (`--parent`).

## Response

In an unattended run (a worker or scheduled run that can't message Tom), don't
use PushNotification or Slack: follow **Unattended runs** in `SKILL.md`, which
returns the SEV1 or SEV2 to the caller with a rollback recommendation and a
fix-forward plan. The steps below are for an attended session.

**SEV1**

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

**SEV2**

1. Confirm the signal and dedupe it.
2. Create the bug: `followup.sh -p 2 --triage "<title>" -d "<body>"`. Use
   `--parent <ticket>` instead of `--triage` when a change from this run caused it.
3. If it is priority 1 or 2 **and** ready (reproducible, cause located, fix scoped,
   acceptance clear), start it now with `yolo-ticket`. Otherwise leave it in Triage
   with the evidence attached.

**SEV3**

- Real defect: `followup.sh --triage -p 3 "<title>" -d "<body>"`.
- Normal behaviour, confirmed by a human: `baseline.sh accept <key> --note "<why>"`.
- Unsure: mention it in the report and let it run another tick.

## Linear ticket body

```markdown
**Symptom.** <what is failing, in one sentence, as a user would see it>

**Evidence (prod-health, <env>, <start>–<end> UTC).**
- <signal>: <count> in <window> vs baseline <rate>/h (<ratio>x) — key `<finding key>`
- Organisations: <Name (org-short)>, … (<n> total)
- Query: `<LogQL / SQL / HogQL from the finding>`

**Started.** <first seen>. Deploys just before: <from→to, PR #…, LLE-…>.

**Impact.** <who, how many, what breaks>. Severity: SEV<n>.

**Next step.** <revert / fix-forward idea / investigate with root-cause>.
```

Never paste secrets, database URLs or customer payloads. Session and org ids are fine.
