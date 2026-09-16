# Pi Extensions

Custom Pi extensions bundled by the Agent Toolkit package. The package exports only this directory; skills are installed separately as managed links.

## Active extensions

- `anthropic-claude-code.ts` — registers Anthropic models using local Claude Code OAuth credentials or an explicitly configured proxy key file.
- `btw.ts` — quick side-question handling.
- `code-writer/` — packaged native `code-writer` subagent role (`agents/code-writer.md`) with the human `/code-writer` command for a single selected model and a session-scoped delegation-preferred routing mode. See [`code-writer/README.md`](code-writer/README.md).
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

## Fable 5.1 compaction compatibility

Fable 5.1 binds thinking blocks to the conversation prefix that produced them.
Pi's client-side compaction replaces older turns with a summary while retaining
recent assistant/tool turns; replaying those turns' old thinking behind the new
prefix can therefore fail with a persistent 400.

For `anthropic-claude-code/claude-fable-5-1` only, a context hook identifies thinking
carried across the latest compaction and removes it from the **outgoing copy**.
Saved session history, text, tool calls and tool results are not modified. Newly
generated thinking after the boundary remains intact, even if timestamps coincide.
The filter runs on subsequent requests too and reconstructs its boundary from the
active session branch on reload/resume. Both `firstKeptEntryId` and self-contained
`retainedTail` compaction formats are supported, including redacted thinking.

Thinking-off is marked unsupported, and summary requests which omit or disable
thinking are normalised to adaptive mode. Existing request-level effort is kept.
Other models, pricing and credential handling are unchanged. Fable 5.1 also uses
the same intentional 272,000-token context budget as Fable 5.

Do not enable `supportsMidConvoEffort` solely to obtain its binding-control flag:
our CPA canary rejected the bundled per-message `output_config` with a 400. This
fix uses Anthropic's documented keep-tail client-compaction alternative instead,
without new beta headers or per-message effort controls. It does not replace Pi's
compactor or enable server-side compaction. Other arbitrary history/system/tool
rewrites can still invalidate thinking and need their own integration review.

After integrating the change, reload Pi and start a fresh session or reselect
Fable 5.1 so the active model uses the updated metadata. This is separate from
changing prsmash's production model.

References: [preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking),
[Fable 5.1 migration](https://platform.claude.com/docs/en/models/fable-5-1/migration-guide).

The default suite tests metadata, non-mutating context filtering and the pinned
SDK's HTTP serialization against a local fake endpoint. To also test the installed
native adapter:

```bash
PI_TEST_ANTHROPIC_API_MODULE=/absolute/path/to/pi-ai/dist/api/anthropic-messages.js \
  bun test tests/extensions/fable-compaction.test.ts
```

The wire tests use synthetic signatures and a loopback fake server, with no real
credentials or model calls. They reproduce a rejected unfiltered keep-tail request,
then verify successful continuation, retained text/tool pairing, preservation of
new thinking, and adaptive summarisation with existing OAuth betas retained.
`tests/fixtures/fable-compaction-canary.ts` is a separate opt-in live fixture for an
explicitly authorised native subagent. It only exposes two in-memory values,
applies the same filter to a synthetic compaction boundary after a completed tool
round, and records non-secret metadata;
it is not loaded by the production provider or normal tests.

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

## Code writer

After `sync.sh` and `/reload`, configure the writer's single model explicitly and optionally prefer delegation for the session:

```text
/code-writer models anthropic-claude-code/claude-fable-5-1:medium
/reload
/code-writer on
```

Each mutating command asks for a UI confirmation and fails closed without one. `models` writes one model, optional thinking, fresh context, `fast: false` and explicit extensions to `subagents.agentOverrides.code-writer`, plus a matching strict per-agent scope. It preserves global policy and unrelated settings under Pi's settings lock. Native pi-subagents 0.68+ removed `fallbackModels`: multiple models are refused, and an explicit single-model reconfiguration removes that legacy writer key. Provider failures are reported, not automatically retried on another model. `on` validates the stored/effective configuration before and after confirmation; it is a routing preference, not a sandbox. See [`code-writer/README.md`](code-writer/README.md).

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
