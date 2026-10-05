# Verification, rollout and incidents

## Health ticks

- At start-up, run `scripts/prod-health.sh --window 30m > $WS_DIR/baseline-health.txt`.
- Tick after each deploy of our change, and otherwise every two hours, from the
  main loop. Session crons don't fire while the session is busy, so don't rely on
  them alone.
- Compare each tick with the baseline and ignore known noise
  (graph-data-tables-service ~800 warn per 30 minutes, argocd errors, sandbox
  Pending during warm-pool churn). Report only a new signal that can be attributed
  to us.
- Programme-specific metrics (latencies, cache rates) go in
  `$WS_DIR/health-extra.sh`, passed with `--extra`.
- Access details are in the memory note `prod-health-check-access`.

## Smoke tests: test what users touch

Logs and pod health missed every user-facing regression last week. Smoke tests
must exercise the real surface:

- frontend changes: load a **public workflow app logged out** and a project page
  logged in, using `lleverage-browser-access`. Check PostHog exceptions too
  (`posthog-debugger`). (#7395 broke every public app for ~15 hours with clean
  server logs.)
- agent and session changes: run a turn in a real project. Include the awkward
  identifiers: project IDs starting with `_` or `-` (LLE-14180 reached internal
  prod), resume after an approval (LLE-14207), and an update to an existing
  entity, not only creation.
- keep the smoke cheap: deterministic, small-budget checks, plus one live
  confirmation. Not repeated 280K-token runs.

## Staged rollout for risky changes

1. Default off behind a flag or cohort. Additive schemas. The deploy order is in
   the PR body.
2. Staging first. The infra `staging` branch drives staging Argo; promote the app
   `staging` branch from main when needed. Whether the orchestrator may promote is
   recorded in `STATE.md`; ask once at the start.
3. Test on staging with sessions created the way users create them (in-app, not
   via a test claim path). Mocks bypassed the real path twice last week.
4. Production for the internal organisation, with a soak: a duration and a call
   count in `STATE.md`, and a scheduled check at the end.
5. Widen in batches. Each step has a rollback written down before it starts.

If staging observability is broken (staging Loki was down for 22 days), declare
the substitute evidence explicitly. Don't skip the check.

## After a merge or infra apply

Verify the effect: the image tag rolled out, pods are healthy, flags are present
in the right pods (shared and per-org pods differ), Argo is synced. Then update
the ticket. Don't stop at "Tom merged it".

## When something breaks

1. Reproduce from the exact symptom the user reported. Write down the symptom
   verbatim and test that, not a nearby hypothesis. (The skill-preview bug was
   first diagnosed as a missing question card.)
2. Attribute it by chronology: when did it first occur, and which deploy preceded
   it? Check older history (the session DB backup, Loki) before calling it ours
   or not ours.
3. Fix forward if the fix is small and well understood. Otherwise revert first.
4. Check whether a fix already exists (another session, a teammate's branch) before
   writing one.
5. Close the loop where the report came from (Slack thread, Linear) after the
   deploy has been verified.
