---
name: posthog-debugger
description: Debug Lleverage client issues using PostHog session recordings and events. Use when the user asks to debug a Linear ticket or client issue with PostHog, mentions a PostHog replay/session recording URL, asks to inspect frontend events, session recordings, persons, 401s, console errors, network issues, or references tickets like LLE-9843 with PostHog context.
metadata:
  author: tvd
  version: 1.0.0
---

# PostHog Debugger

Debug Lleverage client issues using PostHog. The Lleverage PostHog project is fixed to `62494` and hosted at `https://eu.posthog.com`.

Use `scripts/posthog-debug.sh` from this skill directory for API access.

## Configuration

Required credential:

- `POSTHOG_PERSONAL_API_KEY`

Tom keeps this in fish config. Agent shell commands often run through bash, so the helper script automatically falls back to:

```bash
fish -lc 'printf %s "$POSTHOG_PERSONAL_API_KEY"'
```

Defaults:

- `POSTHOG_HOST=https://eu.posthog.com`
- `POSTHOG_PROJECT_ID=62494`

Do not print the API key or commit it to the repo.

## Important Agent Conventions

- Prefer starting from a Linear ticket ID when provided, e.g. `LLE-9843`.
- Use the `linear-cli` skill conventions for reading tickets: `linear-cli issues get <id> --output json --compact --no-pager --quiet`.
- Extract PostHog replay URLs from ticket descriptions and comments.
- Never expose raw secrets in output.
- When reporting findings, include:
  - replay URL and timestamp
  - person/distinct ID/session ID if found
  - relevant frontend events around the incident
  - console or exception events
  - network/backend correlation hints, especially 401s
  - concise likely cause and next debugging steps
- If PostHog data is unavailable due to permissions, say exactly which API call failed and what scope is probably missing.

## Common Commands

From this skill directory:

```bash
# Check API access
bash scripts/posthog-debug.sh whoami

# Extract PostHog URLs from a Linear ticket
bash scripts/posthog-debug.sh ticket LLE-9843

# Fetch recording metadata by replay/recording ID
bash scripts/posthog-debug.sh recording 019e1acf-7611-7987-a8de-2a1f217cdf29

# Summarise a recording: metadata + nearby events when possible
bash scripts/posthog-debug.sh replay 'https://eu.posthog.com/project/62494/replay/019e1acf-7611-7987-a8de-2a1f217cdf29?t=234'

# Run HogQL directly
bash scripts/posthog-debug.sh hogql "select event, timestamp, distinct_id, properties from events where timestamp > now() - interval 1 day limit 20"
```

## Recommended Debug Flow

### 1. Read the ticket

```bash
linear-cli issues get LLE-9843 --output json --compact --no-pager --quiet
```

Extract:

- PostHog replay URL(s)
- reported timestamp
- screenshots and user description
- affected user/org/project if present

### 2. Inspect the replay

```bash
bash scripts/posthog-debug.sh replay '<posthog replay url>'
```

Look for:

- recording ID
- session ID
- distinct/person ID
- start/end times
- browser/OS/page URL
- timestamps relative to `?t=`

### 3. Query events around the incident

If the recording metadata gives a `$session_id`, query around the incident time:

```sql
select
  timestamp,
  event,
  distinct_id,
  properties.$current_url,
  properties.$exception_message,
  properties.$exception_type,
  properties.status,
  properties.status_code,
  properties.url,
  properties.path,
  properties.method,
  properties.response_status
from events
where properties.$session_id = '<session_id>'
order by timestamp asc
limit 200
```

If only a distinct ID is known, constrain by a narrow timestamp window around the reported time.

### 4. Focus queries for common client issues

401/auth issues:

```sql
select timestamp, event, properties.$current_url, properties.url, properties.path, properties.status, properties.status_code, properties.response_status, properties.error
from events
where properties.$session_id = '<session_id>'
  and (
    event ilike '%error%'
    or toString(properties.status) = '401'
    or toString(properties.status_code) = '401'
    or toString(properties.response_status) = '401'
    or properties.error ilike '%401%'
  )
order by timestamp asc
limit 100
```

Console/exceptions:

```sql
select timestamp, event, properties.$exception_type, properties.$exception_message, properties.$exception_stack_trace_raw, properties.$current_url
from events
where properties.$session_id = '<session_id>'
  and (event = '$exception' or event ilike '%error%')
order by timestamp asc
limit 100
```

Agent-specific events:

```sql
select timestamp, event, properties
from events
where properties.$session_id = '<session_id>'
  and (event ilike '%agent%' or properties.$current_url ilike '%agent%')
order by timestamp asc
limit 200
```

### 5. Correlate with other systems

After identifying user/session/time:

- Use `agent-session-debugger` if an agent thread/session ID is visible.
- Use `workflow-debugger` if workflow session IDs appear.
- Use `gcloud-logs` for backend 401s or service errors at the same UTC time.

## Output Template

When finished, summarise like this:

```markdown
## PostHog debug summary

- Ticket: LLE-XXXX
- Replay: <url>
- Incident time: <UTC/time offset>
- Person/distinct ID: <id if known>
- Session ID: <id if known>

### What happened
<short sequence of important events>

### Evidence
- <timestamp> <event/url/status/error>
- <timestamp> <event/url/status/error>

### Likely cause
<concise cause or best hypothesis>

### Next steps
- <actionable next step>
```
