# Pi Extensions

Custom Pi extensions bundled by the root `agent-toolkit` Pi package.

## Extensions

- `anthropic-claude-code.ts` — registers an Anthropic provider using local Claude Code OAuth credentials.
- `goal.ts` — adds `/goal`, durable `/plan`, and continuation tools for long-running objectives.
- `btw.ts` — adds a command for quick side-question handling.
- `scheduler.ts` — adds `/schedule` plus tools for delayed prompts.
- `send-user-message.ts` — adds a lightweight progress-note tool.
- `web-tools/` — adds local web search/fetch tools.
- `worktrees.ts` — adds personal worktree commands.
- `workflows/` — adds dynamic workflow commands for saved multi-subagent TypeScript workflow scripts.
- `brain/` — durable memory as an Open Knowledge Format (OKF) markdown bundle queried by ripgrep and committed to git. Registers `brain_query`/`brain_remember`/`brain_forget` tools, injects recalled context on each turn, and adds `/brain`.
- `guardrails/` — the safety floor for autonomous operation: blocks destructive/banned tool calls (even under `--yolo`) via the `tool_call` hook, with autonomy levels (`high`/`balanced`/`conservative`) and `/guard`.
- `observe/` — the in-terminal oversight surface: `/status` renders a single pane (daemon, goal, schedule, workflows, brain, TADU, recent decisions) over the decision spine.
- `cron/` — durable scheduling via the user's crontab: `/cron` manages a job set (default: the heartbeat) and renders a managed block that runs `toolkit-trigger --cron-job <id>`. Install is deferred (`/cron print` renders the crontab to apply).
- `heartbeat/` — the scheduled check-in loop: detects the heartbeat trigger and injects `HEARTBEAT.md` + the silence rule, suppresses already-handled items, and escalates only what needs attention via `heartbeat_note`. Adds `/heartbeat`.
- `lib/` — shared modules used by several extensions (the `decisions` audit spine and `paths`). It has no `index.ts`, so Pi never loads it as an extension.
- `openai-fast.json` — provider/model configuration retained with the extension set.

## Usage

Install the repository as a Pi package rather than copying these files into `~/.pi/agent/extensions`:

```bash
pi install "$HOME/agent-toolkit"
```

After adding or changing extensions, run `/reload` inside Pi.

## Dynamic workflows

The `workflows/` extension discovers reusable workflow scripts from `.pi/workflows/*.ts` and `~/.pi/agent/workflows/*.ts`.
Project workflows shadow user workflows with the same name and require content-hash approval before running.

Commands:

- `/workflow <name> [args...]` — run a saved workflow in the background.
- `/<workflow-name> [args...]` — dynamic command for discovered workflows after `/reload`.
- `/flow <goal>` — generate a workflow script with the current model, then view/edit/save/run it after approval.
- `/workflows` — list discovered workflows and recent persisted runs.
- `/workflow-save <run-id> [user|project]` — save a run's script snapshot as a reusable workflow.
- `/workflow-rerun <run-id> [fresh|reuse]` — rerun an exact script snapshot, optionally reusing completed agent cache entries.
- `/workflow-apply <run-id> <agent-label> [cwd] [--check]` — check or apply a patch produced by a worktree-isolated agent.
- `/workflow-stop <run-id>` — cancel an active run.

Workflow authoring guidelines:

- Import only `workflow` from `pi-workflows` and default-export `workflow({ name, run })`.
- Use `ctx.phase`, stable agent labels, and `ctx.mapLimit` for bounded fan-out.
- Let `ctx.agent` subagents do filesystem/tool work; workflow scripts should orchestrate only.
- End with `return ctx.report(markdown)`.
- Avoid non-determinism (`Date.now`, `Math.random`) so `/workflow-rerun <id> reuse` can skip completed agents safely.
- Use `isolation: "worktree"` for modifying agents; inspect diffs with `/workflow-show` and apply clean patches with `/workflow-apply`.

Bundled example workflow patterns currently include `auth-audit`, `codebase-audit`, `deep-research`, `migration-plan`, and `validate-branch`.

## Scheduling: scheduler vs cron

- `scheduler.ts` (`/schedule`) is for **in-session, ephemeral** timers — "check
  this PR in 10m". Jobs live in the session and are lost on a full restart.
- `cron/` (`/cron`) is for **durable, periodic** jobs that survive reboot. Each
  managed crontab line runs `toolkit-trigger --cron-job <id>`, dropping a trigger
  the daemon forwards to the resident agent. The prompt text lives in the jobs
  store, so cron lines stay quoting-free. Installation is deferred — `/cron print`
  renders the crontab for you to apply with `crontab <file>`.
- The default cron job is the **heartbeat** (every 30 min). When it runs,
  `heartbeat/` injects `HEARTBEAT.md` + the silence rule, lists already-handled
  items so nothing is re-flagged, and escalates only what needs attention.

## Development and tests

New, multi-file extensions live in a directory with an `index.ts` entry (Pi loads
only `index.ts`), with the bug-prone logic factored into pure modules that import
nothing from Pi/TypeBox so they can be unit-tested directly. Tests are colocated
as `*.test.ts` and run with Bun:

```bash
bun test extensions/        # run the suite
bun run typecheck           # tsc --noEmit (new code is type-clean)
```

Conventions for new extensions:

- Pure cores (parsing, ranking, classification, formatting) carry no Pi imports
  and are exhaustively tested; the `index.ts` is a thin wiring layer.
- Best-effort side effects (recall, capture, audit writes) must never throw or
  block a turn — wrap them and degrade gracefully.
- Match the existing bar: strict TypeScript, TypeBox schemas for tools, British
  English in prose.

Environment knobs (Phase 0): `AGENT_TOOLKIT_BRAIN_ROOT`, `AGENT_TOOLKIT_BRAIN_RECALL`,
`AGENT_TOOLKIT_AUTONOMY`, `AGENT_TOOLKIT_STATE_DIR`.

## Notes

These extensions are personal tooling and may assume local commands or config such as `gh`, `linear`, Claude Code credentials, or local Pi agent settings.
