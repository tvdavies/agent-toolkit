# Checks: sources, coverage and blind spots

Every check prints one JSON result with `--raw` (the orchestrator collects these).
Each result has a `status` (`ok`, `partial`, `unavailable`), absolute `findings`
(problems whatever the baseline says), counted `series` (compared with the baseline
by `lib/assess.py`), `notes`, and `data` (summary, deploys, image tags and so on).

Access for both clusters uses
`~/dev/lleverage-ai/infrastructure/generated/<env>/kubeconfig`. Port-forwards use
free local ports and are killed on exit. Every HTTP call has a timeout.

| Check | Source | Sees | Can't see |
|---|---|---|---|
| `k8s` | kubectl (live); kube-state-metrics in VictoriaMetrics (history) | Pods not ready for more than 5 minutes; CrashLoopBackOff, ImagePullBackOff and CreateContainerConfigError in the window; container restarts; Deployments mid-rollout or stuck (ProgressDeadlineExceeded, or more than 15 minutes); degraded Argo Rollouts; the image tag of every workload | Application-level failure in healthy pods. Past windows (`--end`) get history only, with no live rollout state. |
| `alerts` | Alertmanager v2 (live, excluding silenced and inhibited); `ALERTS` series in VictoriaMetrics for past windows | Every firing alert. Critical alerts are always findings. Other alerts are findings only when the baseline hasn't seen them. `CloudBuildFailed*` gets a sev2 hint. | Alerts nobody wrote. Silenced alerts. |
| `loki-errors` | Loki `loki.source.kubernetes.pod_logs` | Error and warn volume by namespace (level label). Error-like lines without a level label, by namespace. Normalised error signatures (ids, numbers, hashes and emails masked; org namespaces grouped as `org-*`), new or more than 3x the baseline | Errors that are never logged, or logged at info. Loki returns at most 5000 lines per query: when a sample hits the cap, the counts cover only the newest part of the window (noted, and rates scaled). Namespaces with huge raw volume (`litellm`, set by `PH_LOKI_SAMPLE_SKIP`) get counts but no signatures. |
| `http` | Hubble L7 metrics `hubble_http_requests_total` (VictoriaMetrics); Loki structured request logs | 5xx and 401/403/404/429 by destination namespace/workload (ingress traffic through Cilium). Routes from JSON logs with `status`/`statusCode` plus `endpoint`/`url`/`path`/`route` (app, credential-service, gotenberg) and uvicorn access lines (litellm, markitdown), normalised (`/:org/w/:id`, `:id`) | Paths in Hubble (it has no path label). Routes in services that don't log requests: the Next.js app logs only some routes, such as public workflow-session access denials. Cloudflare edge errors. |
| `workflows` | ClickHouse `default.activity_v1 FINAL` (production only), user `claude_readonly` | Production `workflow_completed` terminals with status error, aborted or timeout: by failure category (`eventError.category`), by category/code (including `platform_interrupted/api_execution_uncertain` and `stale_run_reaper`), and by org. The failure rate against completions. | Staging (no staging ClickHouse). Runs that never reach a terminal event. Rows inserted late. Only the flattened `eventError` is parsed, never `eventData`, to stay within ClickHouse memory. |
| `sentry` | Sentry API (`de.sentry.io`, org `lleverage`), token from `~/.sentryclirc` | Events per project (a "went quiet" drop is a finding). Events per issue, excluding CSP `Blocked '...'` reports. Issues first seen in the window. | Projects whose SDK is broken or unsampled (the app project was silent from 4 October; LLE-14309). Rate-limited events (the app project drops many). |
| `posthog` | PostHog HogQL, project 62494, host filter `app.lleverage.ai` / `app.staging.llev.dev` | Browser `$exception` events by type, masked message and masked path (public apps are `/:org/w/:id` and get a sev2 hint). Pageview volume, so a collapse is visible. | Errors swallowed by error boundaries without capture. Users who block PostHog. Quiet hours make drops unreliable; drops need at least 60 expected pageviews. |
| `deploys` | ReplicaSets (kubectl), Argo CD Applications, GitHub REST (`gh api`) | Image changes in the lookback (default `max(window, 3h)`), grouped by from→to tag with workloads, namespaces, commits and PR numbers. Argo syncs grouped by repo and revision, with the infra commit title. Failed Argo syncs. Apps Degraded or Missing for more than 10 minutes. Failed Cloud Build check runs on recent `main` commits (`staging` for staging); sev1 if the same build failed on the newest two commits. `main-tests` failures. | ReplicaSets already garbage-collected (revision history limit). Rollbacks done outside Argo. GraphQL is avoided because of rate limits; REST can still be rate-limited (reported as unavailable). |
| `dispatch` | Session DB `workflow_dispatches` (read-only, through session-service's cloud-sql-proxy sidecar) | Dispatches failed in the window by `failure_code` and environment (`api_execution_uncertain` gets a sev2 hint, LLE-14217). Created volume. Live: dispatches stuck `pending`/`published` for more than 10 minutes, or `accepted` with a lease expired more than 5 minutes ago. | Dispatches that never reach the table. Redelivery shapes that only show in workflow-service logs (see `apps/workflow-service/src/workflow-dispatch/README.md`). |

## Credentials

| Source | Where it comes from |
|---|---|
| ClickHouse | `CLAUDE_CH_USERNAME`, `CLAUDE_CH_PASSWORD` (environment, else `fish -lc`), sent to curl on stdin |
| PostHog | `POSTHOG_PERSONAL_API_KEY` (environment, else fish) |
| Sentry | `SENTRY_AUTH_TOKEN`, else `token=` in `~/.sentryclirc` |
| App DB (org names) | Secret `app/service-secrets` key `DATABASE_URL`, through an app pod's `cloud-sql-proxy` sidecar |
| Session DB | Secret `session-service/service-secrets` key `SESSION_DATABASE_URL`, through a session-service pod's sidecar |
| GitHub | `gh` auth |

Database URLs are parsed into `PG*` variables for the `psql` child process only. They
are never printed or written to disk. Sessions set
`default_transaction_read_only=on` and a 30-second statement timeout.

## Finding keys

Keys identify a signal across runs. Use them with `baseline.sh accept` and
noise patterns (shell globs).

| Prefix | Meaning |
|---|---|
| `k8s.waiting:<ns>/<workload>:<reason>`, `k8s.notready:…`, `k8s.rollout-stuck:…`, `k8s.restarts:<ns-class>/<workload>:<container>` | Kubernetes |
| `alert:<name>\|<ns>`, `alert.critical:<name>\|<ns>` | Alerts |
| `loki.error:<ns>`, `loki.warn:<ns>`, `loki.errlike:<ns>`, `loki.sig:<ns-class>\|<signature>` | Logs |
| `http.svc:<ns>[/<workload>]\|<status>`, `http.route:<ns-class>\|<method> <route>\|<status>` | HTTP |
| `wf.total`, `wf.failed`, `wf.category:<cat>`, `wf.code:<cat>/<code>`, `wf.org:<org id>` | Workflows |
| `sentry.events:<project>`, `sentry.issue:<id>`, `sentry.new:<shortId>` | Sentry |
| `posthog.pageviews`, `posthog.exceptions`, `posthog.exc:<type>\|<message>\|<path>` | PostHog |
| `deploy.build:<name>`, `deploy.argo-failed:<app>`, `deploy.argo-degraded:<app>` | Deploys |
| `dispatch.created`, `dispatch.failed:<code>\|<env>`, `dispatch.stuck:<status>` | Dispatch |

## Running a past window

`--end 2026-10-02T06:21:00Z --window 30m` replays a window for every check except
live state (kubectl pods, Alertmanager silences, stuck dispatches, Argo health).
Use this to confirm when a signal started relative to a deploy. Loki keeps logs
for about 30 days and VictoriaMetrics keeps metrics for 15 days.
