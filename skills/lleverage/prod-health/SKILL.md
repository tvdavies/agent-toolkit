---
name: prod-health
description: Read-only health sweep of Lleverage production or staging across Kubernetes, Alertmanager, Loki errors, HTTP 4xx/5xx, workflow failures (ClickHouse), Sentry, PostHog browser exceptions, recent deploys and workflow dispatches, compared against a stored baseline, with each anomaly tied to the deploys and PRs in the window. Then grades severity and responds - stop merging and alert Tom, file a deduplicated Linear bug, or update the baseline. Use periodically during yolo, sweep or workstream runs, after a merge burst or deploy, or when asked "is prod healthy", "check prod", "health check", "anything broken", "did we break anything" or "prod-health".
compatibility: Requires bash, jq, python3, curl, kubectl with the infrastructure repo's generated kubeconfigs, psql, and gh. Optional credentials - CLAUDE_CH_USERNAME/CLAUDE_CH_PASSWORD (ClickHouse), POSTHOG_PERSONAL_API_KEY, a Sentry token in ~/.sentryclirc. Uses the workstream skill's followup.sh for Linear tickets.
metadata:
  author: tvd
  version: 1.0.0
---

# Prod health

Find out quickly whether production is hurting, how badly, and which change
probably caused it, so the time to recover stays short. Everything this skill
runs is read-only. Acting on production (rollback, flags, restarts, config)
needs Tom's approval.

Scripts live in `scripts/` (run any with `--help`):

- `prod-health.sh` runs every check in parallel and prints a compact report.
  It takes `--env production|staging` (default production), `--window 30m`,
  `--end <ISO time>` for a past window, `--only`/`--skip`, and `--json` for
  other skills. Exit status 0 means healthy, 3 means there are findings and 4
  means nothing was found but a source wasn't fully checked.
  `--watch` is the contract for unattended watchers: JSON `findings` (`key`,
  `severity`, `summary`, `status`, `first_seen`, `last_raised`, evidence) plus
  each source's status; exit 0 with no findings, 3 with findings, anything else
  is a failed run. `status` is `new`, `escalated`, `reraise` or `unchanged`
  against a state file (`references/watching.md`).
- `checks/<name>.sh` runs one check on its own, with the same flags. The checks are
  `k8s`, `alerts`, `loki-errors`, `http`, `workflows`, `sentry`, `posthog`,
  `deploys` and `dispatch`.
- `baseline.sh` captures the baseline, shows it, accepts confirmed noise and
  manages noise patterns.

## When to run

- At the start of a yolo, sweep or workstream run (`--window 30m`), and again
  after each deploy of our change.
- After a burst of merges, about 15 minutes after the last rollout settles.
- Every two hours during long unattended runs. Use the `loop` skill or a cron
  job, but session crons don't fire while the session is busy, so tick from the
  main loop too.
- Whenever someone asks whether prod is healthy.

## Procedure

1. **Run it.** `scripts/prod-health.sh --window 30m`. Use a longer window, such as
   `2h`, after a quiet period or when you're chasing something intermittent. If
   the report says `baseline=none`, run `scripts/baseline.sh capture` first
   (about two minutes), then run the check again.
2. **Read the report.** The verdict line gives the worst severity hint. Each
   finding shows the evidence, a query to re-run, and the deploys in or before the
   window that could explain it. The `-- check:` lines summarise each source.
   A source marked `unavailable` or `partial` has **not** been checked. Say so;
   don't treat it as healthy. See `references/checks.md` for what each check can
   and can't see.
3. **Confirm before acting.** A hint is a suggestion, not a verdict. Look at the
   signal directly (the `query` in the finding, Loki, the workflow-debugger
   skill) and check that it is real, current and new. Dedupe against open
   tickets and the known issues in `MEMORY.md`.
4. **Grade it** using `references/triage.md`:
   - **SEV1**: a customer-facing outage or data loss, errors across many orgs, a
     crashlooping core service, or a failing deploy pipeline that blocks fixes.
   - **SEV2**: a real regression that affects some customers, or a degraded feature.
   - **SEV3**: a low-impact error or noise.
5. **Respond.** If you can't message Tom yourself (you are a worker, or a
   scheduled or unattended run), follow **Unattended runs** below instead of this
   step's messaging.
   - **SEV1**: stop merging, and pause auto-merge on your open PRs. Tell Tom
     immediately with the PushNotification tool, or Slack if that isn't
     available. Give the symptom, the impact, the suspected deploy and PR, and a
     recommendation: **roll back** the suspected release (use the `rollback`
     skill when it exists; until then, propose a revert PR or the previous image
     tag from the `deploys` line and wait for Tom's approval), or **fix forward**
     if the cause is clear and the fix is small. Then file the Linear bug as for
     SEV2, at priority 1.
   - **SEV2**: file a Linear bug with the evidence. If it is priority 1 or 2 and
     ready (cause known, fix scoped, acceptance clear), start it now with
     `yolo-ticket`. Otherwise it goes to Triage.
   - **SEV3**: file a Triage ticket if it is a real defect. If a human confirms
     it is normal, update the baseline (step 7).
6. **File tickets through `followup.sh`.** It is in the workstream skill
   (`../workstream/scripts/followup.sh`) and checks for duplicates before it
   creates anything:
   - use `--triage` for an unrelated bug;
   - use `--parent <ticket>` when a change from the current run caused it;
   - use `-p 1` or `-p 2` for SEV1 and SEV2;
   - in an unattended run for Sal (the production watch), add `-l Sal` to every
     ticket you create, sub-issues and follow-ups included. Don't add the label to
     an existing ticket you dedupe onto or comment on.

   On exit code 3 (a possible duplicate), comment on the existing ticket instead.
   The body follows the template in `references/triage.md`: the symptom, the
   window, counts against the baseline, the exact queries, organisations named by
   name, the candidate deploys and PRs, and the impact.
7. **Teach the baseline.** When Tom or the ticket owner confirms that a finding
   is normal, run `scripts/baseline.sh accept <finding-key> --note "<why>"`,
   which raises that key's baseline rate. Use `baseline.sh noise add '<glob>'
   --note "<why>"` only for something that should never alert. Re-capture the
   baseline (`baseline.sh capture --merge`) after a deliberate traffic change.
   See `references/baselines.md`.
8. **Report** in one short message: the verdict, each confirmed finding with its
   severity and the ticket or action taken, sources that were unavailable, and
   anything waiting on Tom.

## Unattended runs

A worker or scheduled run has no PushNotification or Slack, and must not use
either. Its caller (Sal) tells Tom. A message to Tom is a notification, not the
response, so the work doesn't stop there: return the finding with a fix-forward
plan, and the caller starts the fix without waiting for Tom.

- **SEV1.** Stop merging and pause auto-merge on your own open PRs. File the
  Linear bug in Triage at priority 1 through `followup.sh --triage -p 1 -l Sal`
  (it dedupes; on a duplicate, comment on the existing ticket and don't label it). Then end your run
  at once and return to the caller, at the top of your result:
  `SEV1: <symptom>`, the impact (orgs by name, users, counts), when it started,
  the evidence and queries, the suspected deploy and PR, a **rollback
  recommendation** Tom can approve (the previous image tag from the `deploys`
  line, or the PR to revert), a **fix-forward plan** (the ticket, the cause as far
  as known, the scoped fix, and that `prepare-ticket` then `yolo-ticket` should run
  on it at top priority), and the instruction **"stop other automated merges
  until this is fixed; the SEV1 fix PR is exempt"**. Don't start the fix in the
  same run, and never roll back, revert or change config.
- **SEV2** (a real regression affecting some customers, or a degraded feature).
  File the bug in Triage at priority 2 through `followup.sh --triage -p 2 -l Sal`
  and return the same shape, starting `SEV2: <symptom>`, without the alarm: the
  ticket, the evidence, who is affected, the suspected deploy and PR, a rollback
  recommendation for Tom to approve, and the fix-forward plan (`prepare-ticket`,
  then `yolo-ticket` if Ready). No pause on other merges. A SEV2 that worsens is
  a SEV1.
- **SEV3.** As in step 5.

Fix forward means: the Triage ticket filed through `followup.sh`, then
`prepare-ticket` on it, then `yolo-ticket` if it is Ready. The caller runs those;
the run that found the problem only files and returns.

If `prepare-ticket` later says Needs decision or Blocked, park the ticket with a
comment saying what is needed and return the decision to the caller.

## Investigating a finding

- `root-cause`: chronology, regression attribution, existing fixes.
- `loki-logs` (in the infrastructure repo, `.agents/skills/loki-logs`): log
  queries. Re-run the finding's `query`.
- `workflow-debugger` (in the lleverage repo): sessions, failure categories, node
  inputs and outputs.
- `posthog-debugger`: browser exceptions, replays, 401s seen by users.
- `agent-session-debugger`: agent sessions and runs.
- The `deploys` lines map image tags to commits and PRs. Run
  `gh api repos/lleverage-ai/lleverage/compare/<from>...<to>` for the full list.

## Rules

- Read-only, always: no `kubectl` writes, no rollouts or restarts, no database
  writes, no flag changes. Database access goes through the cloud-sql-proxy
  sidecar with `default_transaction_read_only=on`. Never print or save database
  URLs or tokens.
- Rollback, revert merges to production and config changes need Tom's explicit
  approval.
- Don't create tickets for unconfirmed signals, and don't create duplicates.
- Name organisations by name, not only by id. The report resolves them from the
  app database, cached for six hours.
