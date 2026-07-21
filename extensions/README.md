# Pi Extensions

Custom Pi extensions bundled by the root `agent-toolkit` Pi package.

## Extensions

- `anthropic-claude-code.ts` — registers an Anthropic provider using local Claude Code OAuth credentials.
- `btw.ts` — adds a command for quick side-question handling.
- `scheduler.ts` — adds `/schedule` plus tools for delayed prompts.
- `send-user-message.ts` — adds a lightweight progress-note tool.
- `delegation-policy/` — instructs agents to delegate through `subagent` or `workflow_run`, never by launching agent harnesses through shell tools.
- `web-tools/` — adds local web search/fetch tools.
- `worktrees.ts` — adds personal worktree commands.
- `workflows/` — adds dynamic workflow commands for saved multi-subagent TypeScript workflow scripts.
- `brain/` — durable memory as an Open Knowledge Format (OKF) markdown bundle queried by ripgrep and committed to git. Registers `brain_query`/`brain_remember`/`brain_forget` tools, injects recalled context on each turn, and adds `/brain`.
- `guardrails/` — the safety floor for autonomous operation: blocks destructive/banned tool calls and requires human-only approval for consequential actions such as PR merges via the `tool_call` hook, with autonomy levels (`high`/`balanced`/`conservative`) and `/guard`.
- `observe/` — the in-terminal oversight surface: `/status` renders a single pane (daemon, schedule, workflows, brain, TADU, recent decisions) over the decision spine.
- `cron/` — durable scheduling via the user's crontab: `/cron` manages a job set (default: the heartbeat) and renders a managed block that runs `toolkit-trigger --cron-job <id>`. Install is deferred (`/cron print` renders the crontab to apply).
- `heartbeat/` — the scheduled check-in loop: detects the heartbeat trigger and injects `HEARTBEAT.md` + the silence rule, suppresses already-handled items, and escalates only what needs attention via `heartbeat_note`. Adds `/heartbeat`. The effective cadence is gated to `max(timer, min-interval)` — hourly by default on Claude/Codex subscription auth, 30 min otherwise — inside an optional quiet-hours window, so a fast timer can't over-run it. Existing user-created `HEARTBEAT.md` files are never overwritten.
- `lib/` — shared modules used by several extensions (the `decisions` audit spine and `paths`). It has no `index.ts`, so Pi never loads it as an extension.
- `openai-fast.json` — provider/model configuration retained with the extension set.

## Usage

Install the repository as a Pi package rather than copying these files into `~/.pi/agent/extensions`:

```bash
pi install "$HOME/agent-toolkit"
```

After adding or changing extensions, run `/reload` inside Pi.

## Dynamic workflows

The `workflows/` extension discovers reusable workflow scripts from `.pi/workflows/*.{js,ts}` and `~/.pi/agent/workflows/*.{js,ts}`. Agent-authored `workflow_run` scripts and generated workflows run autonomously after validation; the orchestration sandbox and isolated child repositories are the security boundary rather than a routine confirmation dialog. Project workflows shadow user workflows with the same name and retain one-time approval of an immutable root/dependency hash because their source is repository-provided.

Workflow JavaScript never runs in the Pi process. On Linux it executes under `bubblewrap` with an empty environment, no network or project/user filesystem, a bounded V8 heap, and authenticated access only to orchestration capabilities. There is deliberately no unsafe fallback when that sandbox is unavailable. Runs fail early outside a Git repository. Every subagent runs in a unique detached Git clone outside the launch checkout, built from one pinned tracked snapshot. A child guard limits tools to read/search plus Bash; Bash sees only minimal system runtimes and the clone, clears its environment, and has no network by default. A validated workflow call may request `network: true`; `githubAuth: true` additionally mounts an ephemeral GitHub token. Even then, the child safety floor blocks catastrophic commands and protected-branch pushes while allowing ordinary autonomous work. Non-ignored untracked contents are excluded to avoid copying secrets and are listed in run events.

Commands:

- `/workflow <name> [args...]` — run a saved workflow in the background.
- `/<workflow-name> [args...]` — dynamic command for discovered workflows after `/reload`.
- `/flow <goal>` — interactively generate a workflow script with the current model, then view/edit/save/run it. (Agent-authored `workflow_run` `script`/`generate` calls do not prompt.)
- `/workflows` — list discovered workflows and recent persisted runs.
- `/workflow-save <run-id> [user|project]` — save a run's script snapshot as a reusable workflow.
- `/workflow-rerun <run-id> [fresh|reuse]` — rerun the persisted immutable script snapshot. Individual `agent()` calls must opt into deterministic cache reuse with `cache: true`.
- `/workflow-apply <run-id> <agent-id> [cwd] [--check]` — check or apply an isolated-clone agent patch. Apply refuses repository drift since launch.
- `/workflow-stop <run-id>` — cancel an active run.

Workflow authoring guidelines:

- Use workflows for breadth, confidence, or scale that serial work cannot give; use a direct subagent when only one specialist is needed. With `/workflow-mode on` (the Pi analogue of Claude Code's ultracode) substantive tasks are orchestrated by default — the opt-in gate lives at the mode toggle, and the ON directive is deliberately unhedged.
- Ask `workflow_run` for `mode: "guide"` when authoring. The complete contract is intentionally omitted from ordinary turns.
- Begin with a pure `export const meta = { version: 2, name, description, phases, dependencies? }` literal. Version 2 uses fail-fast child semantics; unversioned saved scripts retain the legacy nullable-failure behavior for compatibility. The remaining plain JavaScript body may use only injected `agent`, `parallel`, `pipeline`, `phase`, `log`, `workflow`, `args`, and `budget` globals.
- Let subagents do every repository, shell, file, and web action. The workflow body only orchestrates.
- `agent(prompt, { schema })` uses pi-subagents' native `structured_output` validation. Invalid or missing structured output fails explicitly before display truncation.
- `agent(prompt, { patches: [diffPath] })` seeds preserved diffs from earlier agents in the same run into a fresh writable clone for isolated review/fix stages. Use `returnMetadata: true` to receive `{ value, agentId, workspacePath, diffPath }` without scraping display text.
- Child Bash is networkless by default. `network: true` is explicit source-approved authority; `githubAuth: true` additionally provides the host's GitHub token and implies network.
- Child failures propagate by default. Use `allowFailure: true` only when a nullable ordinary failure is intentional; cancellation, timeout, budget, and sandbox failures remain terminal.
- Labels are display text and may repeat; persisted agent IDs are the filesystem/control identity. The compatibility phrase `Worktree changes preserved at …` in child output refers to the isolated clone path.
- Nested workflow names must be listed in `meta.dependencies`; dynamic script paths are forbidden and nesting is limited to one level.
- Optimise for wall-clock, not headcount: give every child one bounded deliverable it can finish in minutes, fan out wide-and-shallow, and size the fan-out to the ask. Each child is killed at its wall-clock timeout (default 20 minutes; `PI_WORKFLOW_AGENT_TIMEOUT_MINUTES`, or per-call `timeoutMs`) and counts as an ordinary child failure. Runs deadline at 2 hours by default (`PI_WORKFLOW_MAX_RUN_HOURS`, up to 24). The per-run agent cap is a runaway backstop, not a target (default 200; `PI_WORKFLOW_MAX_AGENTS_PER_RUN`, up to 1000).
- `budget` is an output-token ceiling for workflow children only. Input/cache traffic and parent-loop output do not consume it, and it is not forwarded to pi-subagents' broader `maxTokens` resource limit.
- Never automatically relaunch a whole failed workflow. Retry only a failed child, at most once, for a classified transient failure; deterministic provider/model, repository, input, validation, budget, and resource failures must stop or fall back to direct execution.
- Persisted agent state records requested model, actual model, thinking level, and model-attempt outcomes for routing diagnostics.
- Completion execution and wake delivery are separate persisted states. `sent_unacknowledged` is honest about Pi's current lack of a durable enqueue receipt.

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
bun run test:workflows      # workflow sandbox/state/isolation regression suite
bun run typecheck           # tsc --noEmit (new code is type-clean)
```

Note: the integration tests import the Pi-facing modules, which need the dev deps
(Pi types + TypeBox). A production install (`scripts/install.sh` / `bootstrap.sh`)
runs `npm ci --omit=dev` and strips those — pi provides them to extensions at
runtime, but to run the tests afterwards do `bun install` (or `npm install`) to
restore them.

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
