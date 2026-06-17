# Pi Extensions

Custom Pi extensions bundled by the root `tvd-agent-tools` Pi package.

## Extensions

- `anthropic-claude-code.ts` — registers an Anthropic provider using local Claude Code OAuth credentials.
- `goal.ts` — adds `/goal`, durable `/plan`, and continuation tools for long-running objectives.
- `btw.ts` — adds a command for quick side-question handling.
- `scheduler.ts` — adds `/schedule` plus tools for delayed prompts.
- `send-user-message.ts` — adds a lightweight progress-note tool.
- `web-tools/` — adds local web search/fetch tools.
- `worktrees.ts` — adds personal worktree commands.
- `workflows/` — adds dynamic workflow commands for saved multi-subagent TypeScript workflow scripts.
- `openai-fast.json` — provider/model configuration retained with the extension set.

## Usage

Install the repository as a Pi package rather than copying these files into `~/.pi/agent/extensions`:

```bash
pi install "$HOME/agent-skills"
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

## Notes

These extensions are personal tooling and may assume local commands or config such as `gh`, `linear`, Claude Code credentials, or local Pi agent settings.
