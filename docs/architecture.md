# Agent Toolkit — architecture

A single-user, Pi-based autonomous assistant. It acts on Tom's behalf, runs loops
in the background, and keeps oversight cheap. This document is the map; per-area
detail lives in `extensions/README.md` and `bin/README.md`.

## Three layers

```
                  cron ──┐         Slack (Socket Mode, outbound)
   toolkit-trigger ──────┤         webhooks (loopback) ──┐
   dashboard "steer" ────┤                                │
                         ▼                                ▼
                  ┌──────────────────────  daemon  ──────────────────────┐
                  │  trigger inbox (inbox.jsonl)                          │
                  │  babysits pi --mode rpc (framing, respawn+backoff)    │
                  │  forwards triggers (prompt / follow_up)               │
                  │  pairs Slack-origin triggers → reply to thread        │
                  │  spend cap gate · notify-watcher → Slack · dashboard  │
                  └───────────────┬──────────────────────────────────────┘
                                  │ stdio RPC
                          ┌───────▼────────┐
                          │  resident pi    │  one --mode rpc session, --continue
                          │  (extensions)   │  brain · guardrails · goal · scheduler
                          └───────┬────────┘  cron · heartbeat · observe · workflows
                                  │
        OKF brain (git)  ◄────────┼────────►  decision spine (decisions.jsonl)
                                  ▼
                       notify.jsonl (push, rate-limited)
```

**Layer 1 — resident session.** One `pi --mode rpc --continue` process. It loads
the agent-toolkit package, so all extensions are live. Its JSONL session is
durable; goal/scheduler/plan state restore on `session_start`.

**Layer 2 — daemon (`bin/toolkit-daemon.ts`).** A dumb babysitter with zero LLM
logic: owns the RPC child (strict-LF framing, respawn with backoff, SIGTERM
drain), drains the trigger inbox and forwards each trigger (`prompt` when idle,
`follow_up` when busy), routes Slack replies, enforces the spend cap, runs the
dashboard + notify-watcher.

**Layer 3 — cron.** Managed crontab lines that only ever run
`toolkit-trigger --cron-job <id>` — dropping a trigger the daemon forwards.
Scheduling survives reboot because it lives in the OS.

## Triggers — one chokepoint

Everything that wants the agent to work appends a trigger to `inbox.jsonl`
(`toolkit-trigger`, cron, the dashboard) or arrives over a channel (Slack /
webhook) and is appended by the daemon. The daemon drains with a persisted
cursor and forwards. A trigger may carry an `origin` (e.g. a Slack thread); the
daemon pairs it with the next `agent_end` and posts the reply back.

## The decision spine — one source, four views

Every autonomous act appends one structured line to `decisions.jsonl`
(`recordDecision`). Oversight scales with autonomy by making each decision a
queryable line; the four surfaces are thin readers over it:

1. **TUI** — `/status` renders a single pane in the session.
2. **Web dashboard** (loopback) — board + escalation inbox + schedules + SSE
   live tail + steer/ack controls.
3. **Slack** — DMs/mentions in, replies out; escalations pushed to a channel.
4. **Digests** — `toolkit-digest` summarises the spine over a window.

Attention-worthy items additionally go through `notify()` → `notify.jsonl`
(the **push** channel), which is **rate-limited** by the escalation budget
(max N per window + min gap). When the budget is exhausted, notices stay
pull-only in the spine — the agent keeps working, it does not spam. The daemon's
notify-watcher delivers new notices to Slack.

## Autonomy & guardrails

High autonomy, notify-after: the agent acts end-to-end (including outward,
recoverable actions) and reports. The floor:

- **Guardrails** (`tool_call` hook) block destructive/banned ops even under
  `--yolo` (`rm -rf /`, `sudo`, force-push to protected branches, prod deploy,
  DB drops, `curl|bash`, …). Autonomy levels (`high`/`balanced`/`conservative`)
  soften the "confirm" tier.
- **Spend cap** — the daemon polls `get_session_stats`, and once the daily cap
  is hit it pauses trigger forwarding and escalates once.
- **Heartbeat silence rule** — scheduled check-ins escalate only what needs
  attention; routine outcomes are logged, already-handled items suppressed.
- **Completion audit** — `goal.ts` requires evidence before "complete"; a
  blocked goal escalates.

## Memory — the brain

A git-tracked **OKF** bundle (`~/.local/share/agent-toolkit/brain`): markdown +
YAML frontmatter, queried by ripgrep, written behind a stable
`brain_query`/`brain_remember` seam so the backend can be upgraded without
ripple. Recall is injected each turn; capture commits async on `agent_end`.

## State layout

```
~/.local/state/agent-toolkit/
  inbox.jsonl(.cursor)     trigger queue
  decisions.jsonl          the audit spine
  notify.jsonl             push channel (delivered to Slack)
  daemon-status.json       health for /status + dashboard
  cron-jobs.json           managed job set
  heartbeat-log.md         heartbeat history
  heartbeat-handled.json   TTL dedupe
  escalation-state.json    notify rate-limiter state
  spend-state.json         daily spend accounting
  sessions/                pi session dir (--session-dir)
~/.local/share/agent-toolkit/brain/   OKF knowledge bundle (git)
~/.config/agent-toolkit/{serve.env(0600), HEARTBEAT.md, launch.sh, *.service}
```

## Deployment

Local-first, server-ready. The daemon runs under `systemd --user` (+
`loginctl enable-linger`) and spawns the RPC child. Installation is **deferred**:
`toolkit-daemon --print-units` / `--write-units` render the unit, launcher, and
env template; `/cron print` renders the crontab. The user applies them. Secrets
live in a 0600 env file the daemon refuses to start without securing.

## Code quality

Strict TypeScript; TypeBox tool schemas; pure cores (parsing, ranking,
classification, framing, rate-limiting, accounting) carry no Pi imports and are
unit-tested; the daemon holds zero LLM logic. `bun test` is the gate; new code is
`tsc`-clean. Pi loads TypeScript via jiti (no build step); the daemon runs under
`node --experimental-transform-types`.
