# Daemon & CLIs

The autonomous runtime that keeps a resident agent alive and feeds it work.
Pure, tested building blocks live in [`../daemon/`](../daemon); these are the
executables that wire them together.

## Components

- `toolkit-daemon.ts` — supervises a `pi --mode rpc` child: strict-LF JSONL
  framing (U+2028/2029 safe), respawn with exponential backoff, drains the
  trigger inbox and forwards each trigger (as a `prompt` when idle, `follow_up`
  when busy), answers the extension-UI sub-protocol (auto-cancel by default),
  and writes `daemon-status.json`. Holds **zero** LLM logic.
- `toolkit-trigger.ts` — appends a trigger to `inbox.jsonl` (the reliable
  transport the daemon drains) and, when a TADU workspace is present, also
  creates a TADU task for visibility (best-effort).
- `toolkit-digest.ts` — a deterministic (no-LLM) summary of the decision spine
  over a window, pushed to the notify channel and printed. Schedule via cron or
  run by hand.

The daemon also serves the oversight **dashboard** (loopback `:8788`), delivers
the **notify** push channel to Slack, and enforces the **daily spend cap**.

Cron, Slack (Phase 3), and you all poke the agent through `toolkit-trigger`.

## Runtime model

One resident `pi --mode rpc` process, driven by the daemon over stdio (not an
interactive TTY). You interact with it through `toolkit-trigger`, `/status`,
the decision log, and — later — Slack and the dashboard. The daemon runs under
`systemd --user` so it survives logout/reboot.

## Event ingestion (Slack & webhooks)

External signals reach the agent through the same inbox the daemon drains.

- **Slack (preferred): Socket Mode.** An *outbound* WebSocket — no inbound port
  or tunnel. Set `SLACK_APP_TOKEN` (xapp-…, Socket Mode) and `SLACK_BOT_TOKEN`
  (xoxb-…) plus `SLACK_ALLOWED_USERS` (comma-separated Slack user ids — the
  allowlist is the security boundary, since the agent runs `--yolo`). A DM or
  `@mention` from an allowed user becomes a trigger; the agent's reply is posted
  back to that thread.
- **Generic webhooks (loopback).** With `WEBHOOK_SECRET` set, `POST /trigger`
  on `127.0.0.1:8787` with header `x-toolkit-secret: <secret>` and `{"text": …}`
  queues a trigger. `POST /slack/events` is also served (HMAC-verified with
  `SLACK_SIGNING_SECRET`) for Slack Events-API setups; Socket Mode is preferred.

Built on Node's built-in `WebSocket` + `fetch` — no Slack SDK dependency.

### Deferred Slack-app setup (do this yourself)

1. Create a Slack app; enable **Socket Mode**; add an app-level token with
   `connections:write` → `SLACK_APP_TOKEN`.
2. Add bot scopes (`chat:write`, `app_mentions:read`, `im:history`, …); install
   to the workspace → `SLACK_BOT_TOKEN`.
3. Subscribe to bot events (`message.im`, `app_mention`).
4. Put the tokens + `SLACK_ALLOWED_USERS` in the 0600 env file, then restart the
   daemon. Nothing here creates the Slack app for you.

## Install is deferred

Nothing here installs system services automatically. Render the artefacts, then
run the printed steps yourself:

```bash
# Print the env file, launcher, systemd unit, and the manual install steps:
node --experimental-transform-types --no-warnings bin/toolkit-daemon.ts --print-units

# Or write the launcher + unit (+ a 0600 env template) to ~/.config/agent-toolkit:
node --experimental-transform-types --no-warnings bin/toolkit-daemon.ts --write-units
```

The printed steps cover `systemctl --user enable --now` and
`loginctl enable-linger`. Review them before running.

## Run locally (foreground, for testing)

```bash
AGENT_TOOLKIT_STATE_DIR=~/.local/state/agent-toolkit \
  node --experimental-transform-types --no-warnings bin/toolkit-daemon.ts
# in another shell:
node --experimental-transform-types --no-warnings bin/toolkit-trigger.ts "advance the active goal"
```

## Config (environment)

Core: `AGENT_TOOLKIT_INSTANCE`, `AGENT_TOOLKIT_STATE_DIR`,
`AGENT_TOOLKIT_SESSION_DIR`, `AGENT_TOOLKIT_BRAIN_ROOT`, `AGENT_TOOLKIT_MODEL`,
`AGENT_TOOLKIT_PI_BIN`.

Ingestion (Phase 3): `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_ALLOWED_USERS`,
`SLACK_BOT_USER_ID`, `SLACK_SIGNING_SECRET`, `WEBHOOK_SECRET`, `WEBHOOK_PORT`.
Slack/webhook listeners start only when their tokens/secrets are present. Secrets
belong in the 0600 env file; the daemon refuses to start if that file is
group/world accessible.

Oversight (Phase 4): `AGENT_TOOLKIT_DASHBOARD_PORT` (default 8788),
`AGENT_TOOLKIT_DASHBOARD_TOKEN` (optional bearer), `SLACK_NOTIFY_CHANNEL`
(where the notify push channel is delivered), `AGENT_TOOLKIT_DAILY_CAP_USD`
(daily spend cap; unset/0 disables).

## Tests

`bun test daemon/` covers framing (the U+2028/2029 bug class), inbox dedupe and
cursor, backoff, provisioning renderers, and an end-to-end run of the RPC client
and supervisor against a `fake-pi` fixture subprocess — no model required.
