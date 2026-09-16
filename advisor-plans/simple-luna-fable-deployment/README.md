# Simple Luna/Fable deployment: local setup artefacts

Prepared under plan 002 (`tvdavies/simple-luna-fable-routing`, based on `1d33690`). These are local setup artefacts, not product code. Nothing here runs on import or on package load; nothing here has been applied to the live home or main checkout. Parent acceptance of the reviewed exact patch is required before any of the steps below.

## Manifest

| Artefact | Purpose | Installs to |
|---|---|---|
| `routine-worker.md` | Narrowed Luna worker contract: mechanical edits only (exact-pattern propagation, renames, fixture/import updates, fully specified tests); excludes diagnosis, architecture, unresolved auth/persistence/compatibility/concurrency decisions, substantive coding and review; stops on unexpected complexity. Frontmatter is identical to the live file except `description` (model, thinking, aliases, tools and safety flags unchanged). | `~/.pi/agent/agents/routine-worker.md` (copy by hand, replacing the current file). |
| `reviewer-setup.ts` | One-off reviewer-only settings installer. Strict argument parsing (unknown, duplicate or value-less flags fail before any target is chosen); dry run by default; `--apply` writes exactly `subagents.agentOverrides.reviewer` and `subagents.modelScope.agents.reviewer` through the existing `updateSettingsFile` lock/transaction. Cannot touch code-writer, global scope, parent defaults or other roles. Refuses without writing: any reviewer key it does not itself write (e.g. `systemPrompt`, `subagentOnlyExtensions`, `output`, `skills`, `toolBudget`), wrong types on supported keys, disabled role, customised tools, nested delegation/global context/skills, other extensions, any reviewer entry under a provider-scoped map (user or project), enforced global scope excluding Fable 5.1, project reviewer override or project `modelScope`, unsupported root policy, missing provider extension file, non-directory `--cwd`. Prints affected key paths only, never settings content. | Nothing on disk; it edits the selected settings file only when run with `--apply`. |
| `reviewer-setup.test.ts` | Hermetic tests with synthetic settings and a temporary `HOME`. | Not installed. |

Reviewer configuration written by `--apply` (merged over preserved unrelated keys):

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic-claude-code/claude-fable-5-1",
        "thinking": "medium",
        "defaultContext": "fresh",
        "fast": false,
        "extensions": ["/home/tvd/agent-skills/extensions/anthropic-claude-code.ts"],
        "tools": ["read", "grep", "find", "ls", "contact_supervisor"],
        "inheritProjectContext": true,
        "inheritGlobalContext": false,
        "inheritSkills": false,
        "allowNestedSubagents": false
      }
    },
    "modelScope": {
      "agents": {
        "reviewer": { "enforce": true, "strict": true, "allow": ["anthropic-claude-code/claude-fable-5-1"] }
      }
    }
  }
}
```

Native pi-subagents 0.68+ requires one model and rejects `fallbackModels` even when it is `[]` or `false`. The installer removes a legacy reviewer `fallbackModels` field on explicit apply; it does not migrate other roles.

The extension path is the MAIN checkout on purpose (worktrees are disposable). `review-evidence`, `scout`, the global model scope and the parent model are not changed by anything here.

## Install steps (human, after parent acceptance and integration of the patch into main)

Recheck first: `~/.pi/agent/settings.json` and any effective ancestor `.pi/settings.json` may have changed since the plan snapshot. The installer and `/code-writer` revalidate at run time and refuse conflicts rather than overwrite them.

1. The accepted patch must already be integrated into `/home/tvd/agent-skills` (the local Pi package already points there; no sync step is needed). `/reload` in step 4 picks up the updated packaged agent and routing text.
2. Replace the live worker contract: copy `routine-worker.md` from this directory to `~/.pi/agent/agents/routine-worker.md` (compare frontmatter first; it should be identical except `description`).
3. Reviewer on Fable medium, dry run then apply, from the main checkout:
   ```bash
   bun advisor-plans/simple-luna-fable-deployment/reviewer-setup.ts --cwd "$PWD"
   bun advisor-plans/simple-luna-fable-deployment/reviewer-setup.ts --cwd "$PWD" --apply
   ```
   Run with `--cwd` set to the project you will work in, so the effective project settings are checked. Exit 2 means a malformed command line (nothing was read or written); exit 1 means a conflict was found and nothing was written.
4. In the Pi session, type each command yourself; both mutations show the existing real confirmation dialog and are refused without one:
   ```text
   /code-writer models anthropic-claude-code/claude-fable-5-1:medium
   /reload
   /code-writer on
   ```
5. `/code-writer status` should report `Stored hierarchy (user settings): 1. anthropic-claude-code/claude-fable-5-1:medium`, `Child extensions: /home/tvd/agent-skills/extensions/anthropic-claude-code.ts` and `Session routing: preferred (...)`.

Do not script or inject the slash commands; do not use `reviewer-setup.ts` for anything other than the reviewer entries. A single-model code-writer hierarchy has no automatic fallback: a Fable outage is reported to you and you decide; substantive work is not rerouted to a cheaper role.

## Checks

The parent owns validation of the exact patch in its disposable checkout:

- `bun test ./extensions/code-writer tests/extensions/code-writer-package.test.ts`
- `bun test ./advisor-plans/simple-luna-fable-deployment/reviewer-setup.test.ts` (temporary HOME and fixture provider files only; never touches the real home)
- Root `tsc --noEmit` excludes `advisor-plans`; typecheck the setup files explicitly with the same compiler options, e.g. `tsc --noEmit -p tsconfig.json` plus a run listing `advisor-plans/simple-luna-fable-deployment/reviewer-setup.ts` and its test.
