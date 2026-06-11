---
name: local-dev-services
description: Start, inspect, attach to, and stop Lleverage local development services in background Pi Interactive Shell sessions. Use when the user asks to run the app, workflow engine, data tables, integrations, knowledge, session, channels, agent, or other local dev services for testing.
---

# Local Dev Services

Use this skill to run Lleverage local services as background subprocesses via `pi-interactive-shell`, so the user and agent can inspect logs, attach to terminals, and stop services cleanly.

## Core rule

Start services with:

```bash
pnpm dev --filter <service>
```

Run each service as its own `interactive_shell` background session unless the user explicitly asks for an attached/foreground session.

Prefer `mode: "hands-free"` with `background: true` for long-running dev services:

```ts
interactive_shell({
  command: "pnpm dev --filter app",
  mode: "hands-free",
  background: true,
  name: "dev-app",
  reason: "Local dev service: app"
})
```

Store/report the returned `sessionId` in your response so future turns can inspect or stop that service.

## Service recipes

### Main app UI

Start only the Next.js app:

```ts
interactive_shell({ command: "pnpm dev --filter app", mode: "hands-free", background: true, name: "dev-app", reason: "Local dev service: app" })
```

### Workflow/canvas execution testing

Usually needed for workflow canvas work and node execution:

```ts
interactive_shell({ command: "pnpm dev --filter app", mode: "hands-free", background: true, name: "dev-app", reason: "Local dev service: app" })
interactive_shell({ command: "pnpm dev --filter workflow-service", mode: "hands-free", background: true, name: "dev-workflow-service", reason: "Local dev service: workflow-service" })
```

Add data tables if the feature touches graph data tables:

```ts
interactive_shell({ command: "pnpm dev --filter graph-data-tables-service", mode: "hands-free", background: true, name: "dev-graph-data-tables-service", reason: "Local dev service: graph-data-tables-service" })
```

### Knowledge-base testing

```ts
interactive_shell({ command: "pnpm dev --filter app", mode: "hands-free", background: true, name: "dev-app", reason: "Local dev service: app" })
interactive_shell({ command: "pnpm dev --filter workflow-service", mode: "hands-free", background: true, name: "dev-workflow-service", reason: "Local dev service: workflow-service" })
interactive_shell({ command: "pnpm dev --filter knowledge-service", mode: "hands-free", background: true, name: "dev-knowledge-service", reason: "Local dev service: knowledge-service" })
```

### Integration testing

```ts
interactive_shell({ command: "pnpm dev --filter app", mode: "hands-free", background: true, name: "dev-app", reason: "Local dev service: app" })
interactive_shell({ command: "pnpm dev --filter workflow-service", mode: "hands-free", background: true, name: "dev-workflow-service", reason: "Local dev service: workflow-service" })
interactive_shell({ command: "pnpm dev --filter integration-service", mode: "hands-free", background: true, name: "dev-integration-service", reason: "Local dev service: integration-service" })
interactive_shell({ command: "pnpm dev --filter integration-trigger-service", mode: "hands-free", background: true, name: "dev-integration-trigger-service", reason: "Local dev service: integration-trigger-service" })
interactive_shell({ command: "pnpm dev --filter integration-action-service", mode: "hands-free", background: true, name: "dev-integration-action-service", reason: "Local dev service: integration-action-service" })
interactive_shell({ command: "pnpm dev --filter integration-trigger-deployment-service", mode: "hands-free", background: true, name: "dev-integration-trigger-deployment-service", reason: "Local dev service: integration-trigger-deployment-service" })
```

### Agent work / local agent testing

This is the most common service set for local agent work. Always ensure Docker services are running first:

```bash
docker compose up -d
```

Then start:

```ts
interactive_shell({ command: "pnpm dev --filter app", mode: "hands-free", background: true, name: "dev-app", reason: "Local dev service: app" })
interactive_shell({ command: "pnpm dev --filter workflow-service", mode: "hands-free", background: true, name: "dev-workflow-service", reason: "Local dev service: workflow-service" })
interactive_shell({ command: "pnpm dev --filter session-service", mode: "hands-free", background: true, name: "dev-session-service", reason: "Local dev service: session-service" })
interactive_shell({ command: "pnpm dev --filter data-service", mode: "hands-free", background: true, name: "dev-data-service", reason: "Local dev service: data-service" })
interactive_shell({ command: "pnpm dev --filter agent-sandbox-service", mode: "hands-free", background: true, name: "dev-agent-sandbox-service", reason: "Local dev service: agent-sandbox-service" })
```

### Data-service testing

```ts
interactive_shell({ command: "pnpm dev --filter app", mode: "hands-free", background: true, name: "dev-app", reason: "Local dev service: app" })
interactive_shell({ command: "pnpm dev --filter data-service", mode: "hands-free", background: true, name: "dev-data-service", reason: "Local dev service: data-service" })
```

### Custom service

If the user names a service, use the exact filter:

```ts
interactive_shell({
  command: "pnpm dev --filter <service>",
  mode: "hands-free",
  background: true,
  name: "dev-<service>",
  reason: "Local dev service: <service>"
})
```

Known app/service filters with dev scripts include: `app`, `workflow-service`, `session-service`, `channels-service`, `agent-sandbox-service`, `data-service`, `knowledge-service`, `integration-service`, `integration-trigger-service`, `integration-action-service`, `integration-trigger-deployment-service`, `credential-service`, `logging-service`, `graph-data-tables-service`, `actions-service`, `custom-integration-broker-service`, `notification-service`, `markitdown-service`, `memory-service`, `erp-sync-service`, `partners-app`, `agent-cli`, `mcp-server`, `core-nodes-service`, `code-sandbox-service`, `code-sandbox-worker`, `code-sandbox-runner`, `agent-sandbox-runner`.

## Inspecting services

List background sessions:

```ts
interactive_shell({ listBackground: true })
```

Check a service by `sessionId`:

```ts
interactive_shell({ sessionId: "<sessionId>", outputLines: 80, outputMaxChars: 20000 })
```

Fetch only new output since the last check:

```ts
interactive_shell({ sessionId: "<sessionId>", drain: true })
```

Attach a terminal UI so the user can watch or take over:

```ts
interactive_shell({ attach: "<sessionId>", mode: "hands-free" })
```

Stop a service:

```ts
interactive_shell({ sessionId: "<sessionId>", kill: true })
```

Dismiss a background session by ID, or all sessions when the user explicitly asks:

```ts
interactive_shell({ dismissBackground: "<sessionId>" })
interactive_shell({ dismissBackground: true })
```

## Readiness checks

After starting services, wait for quiet output and then inspect each session. Report whether each service appears ready, still starting, or failed. Do not assume readiness from process existence alone; check stdout/stderr for successful startup messages or errors.

Common failure signs: missing environment variables, port already in use, database connection failures, migration failures, package install errors, or Turbo filter errors.

## Local infrastructure

Before starting service bundles, make sure Docker services are running.

**Important:** Docker Compose must be run from the canonical Lleverage monorepo checkout, not from a Pi worktree or arbitrary current directory. Use `/home/tvd/dev/lleverage-ai/lleverage` as the working directory for Docker Compose commands:

```bash
cd /home/tvd/dev/lleverage-ai/lleverage && docker compose up -d
```

When using the bash tool, set `cwd`/run the command from `/home/tvd/dev/lleverage-ai/lleverage` rather than the current working directory.

Use normal `bash` for this one-shot infrastructure command unless the user asks to keep infra logs attached. If they want logs, use:

```ts
interactive_shell({ command: "docker compose logs -f", cwd: "/home/tvd/dev/lleverage-ai/lleverage", mode: "hands-free", background: true, name: "dev-infra-logs", reason: "Local Docker Compose logs" })
```

## User communication

When starting services, give a compact table with service name, command, and `sessionId`. Mention that the user can ask to attach to or stop any service by name.
