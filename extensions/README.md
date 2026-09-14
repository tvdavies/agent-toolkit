# Pi Extensions

Custom Pi extensions bundled by the Agent Toolkit package. The package exports only this directory; skills are installed separately as managed links.

## Active extensions

- `anthropic-claude-code.ts` — registers Anthropic models using local Claude Code OAuth credentials or an explicitly configured proxy key file.
- `btw.ts` — quick side-question handling.
- `delegation-policy/` — requires agent delegation through approved Pi tools rather than shell-launched agent harnesses.
- `openai-fast-cpa.ts` and `openai-fast.json` — the local OpenAI fast provider/model configuration.
- `scheduler.ts` — in-session delayed prompts and `/schedule`.
- `session-handoff/` — chat-requested `handoff_sessions` batches with human confirmation, optional `/skill:handoff`/`/handoff` commands, and independent stable Pi/own-window naming through `set_session_name` and `/session-label`.
- `send-user-message.ts` — lightweight user progress notes.
- `workflows/` — saved and generated multi-agent workflows, isolated child repositories, sandboxing, and the workflow child safety floor.
- `worktrees.ts` — deterministic worktree tooling and personal worktree commands.

The daemon, Brain, memory, cron, heartbeat, observe, self-update, local web-tools, and loadable guardrails integrations have been removed. Web access is supplied by the third-party `pi-web-access` package. The pure command policy needed by workflow children now lives in `workflows/child-policy.ts` and is not loaded as a general host guardrails extension.

## Usage

Synchronise dependencies, skills, the local Pi package, workflows, and managed third-party packages with the repository's canonical command:

```bash
./scripts/sync.sh
```

The installed package points at this checkout, so edits to an existing extension are live on disk. Run `sync.sh` after adding an extension or changing runtime dependencies, then run `/reload` in active Pi sessions.

## Handoff and session labels

After syncing and `/reload`, ask in chat to create sessions—for example, three
sessions for Ally, Wally and Billy. The discoverable `handoff` skill uses the
`handoff_sessions` tool for a bounded batch of 1–6 sessions with one visible human
confirmation. Each entry can carry a local file, HTTP(S) URL or short brief. This
permits model invocation in response to your request, not autonomous spawning.

`/skill:handoff [file|URL]` and `/handoff` remain optional one-session commands;
without a reference or instructions, an editor collects a brief. New conversations
prepare read-only and wait. The parent receives per-session window/pane receipts,
not proof of model readiness; a partial failure stops the rest without rollback,
retries, messaging or replacing existing windows.

The separate `session-name` skill can use `set_session_name` when a sustained task
becomes clear. It preserves assigned identities such as Ally, protects manual
names, makes repeat labels no-ops and rate-limits topic changes. Only a verified,
unshared single-pane window is eligible; it never renames the containing tmux
session (`ll`, for example). A user-confirmed `/session-label` can override naming
state. See [`session-handoff/README.md`](session-handoff/README.md) for the boundary,
commands and failure behaviour.

## Workflows

The workflows extension discovers reusable scripts from project `.pi/workflows/*.{js,ts}` and user `~/.pi/agent/workflows/*.{js,ts}` paths. This repository ships `debug-issue`, `implement-ticket`, and `review-pr`; `scripts/sync.sh` invokes the internal workflow reconciler to link them into the user workflow directory.

Workflow JavaScript does not run in the Pi process. On Linux it runs under Bubblewrap with an empty environment, no project/user filesystem, bounded resources, and no network unless the validated workflow explicitly requests it. Each child works in a unique isolated tracked clone. Its child guard:

- confines built-in path tools to that clone;
- wraps Bash in a minimal Bubblewrap namespace;
- blocks catastrophic commands and protected-branch pushes using the colocated pure child policy; and
- exposes network or an ephemeral GitHub token only when explicitly authorised by the validated workflow call.

There is no unsafe fallback if the required sandbox is unavailable.

Key commands:

- `/workflow <name> [args...]` — run a saved workflow.
- `/<workflow-name> [args...]` — run a discovered workflow command after reload.
- `/flow <goal>` — generate, inspect, save, or run a workflow.
- `/workflows` — list workflows and persisted runs.
- `/workflow-save`, `/workflow-rerun`, `/workflow-apply`, and `/workflow-stop` — manage persisted runs.
- `/workflow-mode explicit|proactive|ultracode|auto|status` — control orchestration policy.

Workflow mode remains explicit by default. Use workflows when the user asks for workflow/ultracode execution or when the configured policy permits it; ordinary focused work should use direct execution or a bounded subagent.

## Development

```bash
npm ci
npm run typecheck
npm test
```

Extension tests are colocated as `*.test.ts`; toolkit-level installer and skill tests live under `tests/`. New multi-file extensions should use a directory with an `index.ts` entry and keep bug-prone logic in testable pure modules.
