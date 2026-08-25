---
name: analyse-agent-sessions
description: Analyse Lleverage platform-agent sessions for agent errors, agent behaviour, and user activity. Use when asked to analyse agent sessions, find agent errors or failure patterns, report on what users are doing with the agent, summarise sessions for an organisation/project/user, or review agent activity in a date range. Works from the local session database backup first, with Loki for agent-service/session-service logs. Handles specific session IDs, org/project/user scopes, and date ranges.
metadata:
  author: tvd
  version: 1.0.0
---

# Analyse Agent Sessions

Analyse agent sessions across three axes: **agent errors** (failed runs, error events, tool failures), **agent behaviour** (tool usage, run durations, transcript patterns), and **user activity** (who is using the agent, how much, for what).

This skill is for targeted and aggregate analysis. For deep incident-style debugging of one session (stuck runs, projection drift, sandbox latency, pod behaviour), hand off to the `agent-session-debugger` skill in the lleverage repo (`.agents/skills/agent-session-debugger/SKILL.md`), which includes a first-sweep script. For workflow execution telemetry use the `workflow-debugger` skill (ClickHouse).

> **READ-ONLY** — only run `SELECT` queries and log reads. Never mutate session data, never re-run agent tool calls, never call external customer APIs.

## Data sources, in priority order

1. **Local session database backup** (`SESSION_DATABASE_URL` in the lleverage repo `.env`) — canonical sessions, runs, transcripts, events, state transitions. Always start here.
2. **Local main app database backup** (`DATABASE_URL` in the same `.env`) — resolve org short names, user emails, project titles to/from IDs.
3. **Loki** — `agent-service` and `session-service` logs, only when the databases do not answer the question (service-level errors, stack traces, request failures, or activity newer than the backup).
4. Escalate only if needed: production Cloud SQL via `cloud-sql-proxy` (see agent-session-debugger), ClickHouse `managed_model_access` (see workflow-debugger), GCS artefacts.

## Setup

Run everything from the lleverage repo root:

```bash
cd ~/dev/lleverage-ai/lleverage
SDB=$(grep '^SESSION_DATABASE_URL=' .env | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
ADB=$(grep '^DATABASE_URL=' .env | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
```

**Check backup freshness first.** The local databases are point-in-time restores of production:

```bash
psql "$SDB" -c "SELECT count(*) AS sessions, max(last_activity_at) AS latest FROM sessions;"
```

If the window you need to analyse is newer than `latest`, either refresh the backup (takes a few minutes, drops and recreates the local DBs, requires `gcloud auth application-default login` and `cloud-sql-proxy`):

```bash
tooling/scripts/prod-db-to-local.sh --database session   # add --database all to refresh the main DB too
```

…or fall back to Loki for the recent window and say so in your findings.

## Resolving scope

The request will scope the analysis by one or more of: session ID(s), organisation, project, user, and a date range.

### Session IDs

Agent session IDs look like `agent-thread-...`. From an app URL, `https://app.lleverage.ai/{orgShortName}/projects/{projectId}/agent?thread={threadId}`, the session ID is the `thread` query param.

### Organisation / project / user

Users refer to these by name, short name, email, or project title. Resolve them in the **main** DB (note: quoted camelCase columns):

```bash
psql "$ADB" -c "SELECT id, name, \"shortName\" FROM organisations WHERE \"shortName\" = 'acme' OR name ILIKE '%acme%';"
psql "$ADB" -c "SELECT id, email, name FROM users WHERE email ILIKE '%jane%' OR name ILIKE '%jane%';"
psql "$ADB" -c "SELECT id, title, \"organisationId\" FROM projects WHERE id = 'xxxxxxxx' OR title ILIKE '%invoices%';"
```

Reverse mapping (IDs found in session data → human names) uses the same tables. Always translate IDs to names in the final report.

### Date ranges

All session DB timestamps are `timestamptz` (UTC). Scope with `created_at` (when the session started) or `last_activity_at` (when it was last touched). Interpret vague ranges ("last week") in UTC and state the resolved range in the report.

## Session database model

Schema source of truth: `packages/session-database/src/schema.ts`. Everything joins through `sessions.id` (= session/thread ID).

| Table | Use for |
| --- | --- |
| `sessions` | scope filtering: `kind`, `organisation_id`, `project_id`, `created_by_user_id`, `current_state`, `state_reason`, `created_at`, `last_activity_at`, `archived_at`, `deleted_at` |
| `session_runs` | agent turns: `status` (`created`/`streaming`/`committed`/`failed`/`cancelled`/`superseded`), `created_at`/`activated_at`/`finished_at`, `started_by_user_id`, `source_provider` (channel origin), `metadata` |
| `session_entries` | transcript: `role` (`user`/`assistant`/`tool`), `ordinal`, `payload` (message object, see below), `deleted_at` |
| `session_events` | durable event log: `event_type`, `occurred_at`, `run_id`, `payload` |
| `session_state_transitions` | state changes with `from_state`, `to_state`, `reason`, `source` |
| `session_checkpoints`, `session_branches` | resume/branch state (mostly for the debugger skill) |

Facts to rely on (verify with a quick `GROUP BY` if something looks off):

- **Filter `kind = 'agent'`** — the table also holds `workflow_app` sessions, which dominate by volume.
- `sessions.current_state` values observed: `idle`, `failed`, `interrupted`, `cancelled`.
- High-signal `session_events.event_type` values: `session.run.started`, `session.run.finalised`, `session.run.failed`, `session.run.cancelled`, `user.message.created`, `assistant.message.completed`, `assistant.tool_call.created`, `assistant.tool_result.created`, `agent.interrupt.created`/`resolved`, `session.context.compacted`.
- `session_entries.payload` is a message object: `{ id, role, parts, metadata, createdAt, parentMessageId }`. `parts[]` elements have `type` (`text`, `tool-call`, …); `tool-call` parts carry `toolName`, `input`, `output`, `isError`, `toolCallId`.

## Analysis cookbook

Define the scope once per psql invocation with `-v` variables. Base cohort pattern — drop or add predicates as the scope requires:

```bash
psql "$SDB" -v org="org-..." -v from="2026-08-01" -v to="2026-08-24" <<'SQL'
SELECT id, project_id, created_by_user_id, title, current_state, state_reason,
       created_at, last_activity_at
FROM sessions
WHERE kind = 'agent'
  AND deleted_at IS NULL
  AND organisation_id = :'org'
  -- AND project_id = :'project'
  -- AND created_by_user_id = :'user'
  AND created_at >= :'from' AND created_at < :'to'
ORDER BY last_activity_at DESC
LIMIT 200;
SQL
```

For a specific session list, use `WHERE id = ANY(ARRAY['agent-thread-...','agent-thread-...'])` instead of the scope predicates.

### User activity

```sql
-- Sessions per day
SELECT date_trunc('day', created_at) AS day, count(*) AS sessions,
       count(DISTINCT created_by_user_id) AS users
FROM sessions
WHERE kind = 'agent' AND deleted_at IS NULL AND <scope>
GROUP BY 1 ORDER BY 1;

-- Per-user activity (translate user IDs via the main DB afterwards)
SELECT s.created_by_user_id, count(*) AS sessions,
       sum(msg.user_messages) AS user_messages, max(s.last_activity_at) AS last_active
FROM sessions s
LEFT JOIN LATERAL (
  SELECT count(*) AS user_messages FROM session_entries e
  WHERE e.session_id = s.id AND e.role = 'user' AND e.deleted_at IS NULL
) msg ON true
WHERE s.kind = 'agent' AND s.deleted_at IS NULL AND <scope>
GROUP BY 1 ORDER BY sessions DESC;

-- What are users asking? First user message per session (previews only)
SELECT s.id, s.created_at, left(e.payload->'parts'->0->>'text', 300) AS first_prompt
FROM sessions s
JOIN LATERAL (
  SELECT payload FROM session_entries
  WHERE session_id = s.id AND role = 'user' AND deleted_at IS NULL
  ORDER BY ordinal ASC LIMIT 1
) e ON true
WHERE s.kind = 'agent' AND s.deleted_at IS NULL AND <scope>
ORDER BY s.created_at DESC LIMIT 100;
```

Channel-originated activity: group `session_runs.source_provider` / `source_origin` to split app vs Slack/email/etc. traffic.

### Agent errors

```sql
-- Failure overview: run outcomes across the cohort
SELECT r.status, count(*)
FROM session_runs r JOIN sessions s ON s.id = r.session_id
WHERE s.kind = 'agent' AND s.deleted_at IS NULL AND <scope>
GROUP BY 1 ORDER BY 2 DESC;

-- Failed/cancelled runs with reasons
SELECT r.session_id, r.id AS run_id, r.created_at, r.finished_at,
       left(r.metadata::text, 500) AS metadata_preview
FROM session_runs r JOIN sessions s ON s.id = r.session_id
WHERE s.kind = 'agent' AND s.deleted_at IS NULL AND <scope>
  AND r.status IN ('failed', 'cancelled')
ORDER BY r.created_at DESC LIMIT 100;

-- Sessions stuck in a bad state, and why
SELECT id, current_state, state_reason, state_changed_at, last_activity_at
FROM sessions
WHERE kind = 'agent' AND deleted_at IS NULL AND <scope>
  AND current_state <> 'idle'
ORDER BY state_changed_at DESC;

-- run-failure events with payloads (error messages live here)
SELECT e.session_id, e.occurred_at, e.event_type, left(e.payload::text, 600) AS payload_preview
FROM session_events e JOIN sessions s ON s.id = e.session_id
WHERE s.kind = 'agent' AND s.deleted_at IS NULL AND <scope>
  AND e.event_type IN ('session.run.failed', 'session.run.cancelled')
ORDER BY e.occurred_at DESC LIMIT 200;

-- Failing tool calls: which tools error, and with what
SELECT part->>'toolName' AS tool, count(*) AS errors,
       left(min(part->>'output'), 300) AS example_output
FROM session_entries e
JOIN sessions s ON s.id = e.session_id,
     jsonb_array_elements(e.payload->'parts') part
WHERE s.kind = 'agent' AND s.deleted_at IS NULL AND <scope>
  AND e.deleted_at IS NULL
  AND part->>'type' = 'tool-call'
  AND (part->>'isError')::boolean IS TRUE
GROUP BY 1 ORDER BY errors DESC;
```

Cluster error reasons/messages into themes; report counts per theme with 2–3 example session IDs each, not every occurrence.

### Agent behaviour

```sql
-- Tool usage distribution across the cohort
SELECT part->>'toolName' AS tool, count(*) AS calls,
       count(*) FILTER (WHERE (part->>'isError')::boolean) AS errors
FROM session_entries e
JOIN sessions s ON s.id = e.session_id,
     jsonb_array_elements(e.payload->'parts') part
WHERE s.kind = 'agent' AND s.deleted_at IS NULL AND <scope>
  AND e.deleted_at IS NULL AND part->>'type' = 'tool-call'
GROUP BY 1 ORDER BY calls DESC;

-- Run duration profile (committed runs)
SELECT count(*) AS runs,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.finished_at - r.created_at)) AS p50_s,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM r.finished_at - r.created_at)) AS p90_s,
       max(extract(epoch FROM r.finished_at - r.created_at)) AS max_s
FROM session_runs r JOIN sessions s ON s.id = r.session_id
WHERE s.kind = 'agent' AND s.deleted_at IS NULL AND <scope>
  AND r.status = 'committed' AND r.finished_at IS NOT NULL;

-- Interrupt/approval friction
SELECT e.event_type, count(*) FROM session_events e
JOIN sessions s ON s.id = e.session_id
WHERE s.kind = 'agent' AND s.deleted_at IS NULL AND <scope>
  AND e.event_type LIKE 'agent.interrupt%'
GROUP BY 1;
```

### Reading one session's transcript

For a session that needs a closer look, read entries in order with bounded previews:

```bash
psql "$SDB" -v sid="agent-thread-..." <<'SQL'
SELECT ordinal, role, created_at,
       (SELECT string_agg(coalesce(p->>'toolName', left(p->>'text', 200)), ' | ')
        FROM jsonb_array_elements(payload->'parts') p) AS content_preview
FROM session_entries
WHERE session_id = :'sid' AND deleted_at IS NULL
ORDER BY ordinal ASC LIMIT 300;
SQL
```

If the question becomes "why did this specific session misbehave?", switch to the `agent-session-debugger` skill and its sweep script:

```bash
.agents/skills/agent-session-debugger/scripts/session-context-sweep.sh 'agent-thread-...'
```

## Loki logs (agent-service / session-service)

Use Loki only when the session DB does not answer the question: service-level exceptions, request failures, infra errors, or activity newer than the local backup. Full access details are in the `loki-logs` skill in the infrastructure repo (`~/dev/lleverage-ai/infrastructure/.agents/skills/loki-logs/SKILL.md`).

Where agent logs live:

| Namespace | What |
| --- | --- |
| `agent-service` | agent runtime: run lifecycle, model loop, orchestration, cancellation, sandbox client calls, event emission |
| `session-service` | canonical session persistence, event ingestion, projections, live websockets |
| `org-<shortName>` (container `workflow-service`) | workflow/node execution for agent tools, and per-thread agent execution for **older** sessions (pre agent-service extraction) |
| `agent-sandbox-service` | sandbox acquire/evict/exec lifecycle |

Setup (production; use the staging kubeconfig for staging):

```bash
export KUBECONFIG=~/dev/lleverage-ai/infrastructure/generated/production/kubeconfig
kubectl -n loki port-forward --address 127.0.0.1 svc/loki 3100:3100 >/tmp/loki-pf.log 2>&1 &
PF=$!; trap 'kill $PF 2>/dev/null || true' EXIT; sleep 2
```

Scoped queries — always filter, always limit:

```bash
# One session, wherever it was handled
logcli --addr=http://127.0.0.1:3100 query --since=24h --limit=100 --forward --output=raw \
  '{namespace=~"agent-service|session-service|org-.*"} |= "agent-thread-<id>"'

# Errors in the agent runtime for a date range (RFC3339, UTC)
logcli --addr=http://127.0.0.1:3100 query --limit=200 --forward \
  --from="2026-08-20T00:00:00Z" --to="2026-08-21T00:00:00Z" \
  '{namespace="agent-service"} |~ "(?i)error|exception|failed|timeout"'

# Org-scoped: per-org namespaces use the org short name; shared services log org IDs in-line
logcli --addr=http://127.0.0.1:3100 query --since=6h --limit=100 \
  '{namespace="agent-service"} |= "org-<organisation-id>"'
logcli --addr=http://127.0.0.1:3100 query --since=6h --limit=100 \
  '{namespace="org-<shortname>", container="workflow-service"} |= "[agent]"'
```

If `GRAFANA_URL` and `GRAFANA_SERVICE_ACCOUNT_TOKEN` are available in the environment, the Grafana datasource proxy (`$GRAFANA_URL/api/datasources/proxy/uid/<loki-uid>/loki/api/v1/query_range`) works without a port-forward — see the sweep script in `agent-session-debugger` for a worked example.

## Reporting

Structure findings as:

```text
Scope: <org/project/user names + IDs, date range (UTC), N sessions / M runs>
Data: <local session DB backup (fresh to <timestamp>), Loki windows queried, any gaps>

Headline findings:
- <finding, with counts and 2-3 example session IDs>

Error themes (if analysing errors):
- <theme>: <count> — example: <session ID>, "<short error excerpt>"

Activity summary (if analysing usage):
- <sessions/day, active users, top use cases from first prompts, tool mix>

Suggested follow-up:
- <e.g. deep-debug session X with agent-session-debugger, refresh backup, check Loki window>
```

Translate all IDs to human names (org, project, user) where you resolved them. Note explicitly when the local backup was stale for part of the requested window.

## Safety and privacy

- Read-only. Never run `INSERT`/`UPDATE`/`DELETE`/DDL against any database.
- Transcript payloads and tool inputs/outputs can contain customer data and secrets. Query with `left(...)` previews and `LIMIT`; never dump full payloads into the report.
- Do not paste API keys, tokens, signed URLs, or credentials found in payloads or logs.
- Aggregate before you quote: prefer counts and themes over verbatim customer content; quote the minimum excerpt needed as evidence.
