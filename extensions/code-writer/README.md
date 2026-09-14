# code-writer

A dedicated native [pi-subagents](https://github.com/nicobailon/pi-subagents) code-writing role whose model is chosen independently of the parent session, with a human-editable ordered model hierarchy and native quota/availability fallback to the next candidate. The parent keeps investigation, decisions, test execution, review and validation.

Inspected against the independently installed native pi-subagents **0.66.0**. The toolkit's bundled pi-subagents 0.28 dependency is used only by the separate workflows adapter and is not upgraded or imported here.

## What is packaged

- `agents/code-writer.md` — advertised, fresh-context, async by default. Tools: `read, grep, find, ls, edit, write, contact_supervisor`. No shell, no nested subagents, no global context or skills catalog; repository instructions are inherited. `acceptance: none` with `acceptanceRole: writer`: completion acknowledges an **unverified patch handoff**; the parent must validate before accepting. The file deliberately sets **no model**: the model hierarchy is deployment configuration.
- `package.json` declares `"pi-subagents": { "agents": ["./agents"] }` so the installed local package exposes the agent (package agents load above builtins and below user/project agents).
- This extension registers one human slash command and a session-scoped routing preference. There is **no model-facing setter** and no launcher: launches go through the normal `subagent` tool.

## Activation

```bash
./scripts/sync.sh        # records this checkout as the local Pi package
```

Then in each Pi session: `/reload`, followed by an explicit hierarchy and, if wanted, the routing preference:

```text
/code-writer models anthropic-claude-code/claude-fable-5-1 openai-codex/gpt-6-astra openai-codex/gpt-5.6-luna
/reload
/code-writer on
```

Nothing is enabled or written on package load; the example hierarchy above is documentation and is never saved unless you type it. Your default parent model and the other worker roles are untouched.

## Commands

| Command | Effect |
|---|---|
| `/code-writer status` | Session routing state; the **stored** user hierarchy, scope and child extensions; whether **effective** project settings override or replace it; the reload requirement; and the native fallback limits. |
| `/code-writer models <provider/id[:thinking]> ...` | After a UI confirmation, writes the ordered hierarchy (1–6 unique, fully qualified models; per-model `:off|minimal|low|medium|high|xhigh|max` suffix) to `~/.pi/agent/settings.json`. Repeating the command adds, removes, replaces or reorders the chain. Requires `/reload` before new launches use it. |
| `/code-writer on` | After a UI confirmation, delegation-preferred routing for this session. Refused, leaving routing unchanged, unless the configuration **as it currently stands** would launch the writer on the stored hierarchy (see below). |
| `/code-writer off` | After a UI confirmation, turns the routing preference off for this session. |

Every mutating action requires an explicit confirmation dialog in the interactive Pi UI and fails closed without a UI or when declined. This is deliberate: Pi dispatches extension slash commands before source-aware input hooks, so a command name alone does not prove a human typed it (an extension could inject it through `sendUserMessage`). The preview shown in the dialog is computed from a snapshot; the actual write recomputes and revalidates everything under the settings lock.

### What `models` writes

Exactly, and nothing else:

```json
{
  "subagents": {
    "agentOverrides": {
      "code-writer": {
        "model": "anthropic-claude-code/claude-fable-5-1",
        "fallbackModels": ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna"],
        "defaultContext": "fresh",
        "fast": false,
        "extensions": ["<this checkout>/extensions/anthropic-claude-code.ts"]
      }
    },
    "modelScope": {
      "agents": {
        "code-writer": { "enforce": true, "strict": true, "allow": ["anthropic-claude-code/claude-fable-5-1", "openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna"] }
      }
    }
  }
}
```

- A primary `:thinking` suffix becomes the override's `thinking`; fallback suffixes stay on the `fallbackModels` entries, which native pi-subagents supports.
- The per-agent scope lists **every** hierarchy model and is replaced wholesale on each run; it is command-owned, so a later hierarchy is never validated against it. Scope is enforcement, not routing. Native applies an agent rule's `enforce: true` independently of the global flag. The existing global `modelScope.allow` (immutable here; a literal `inherit` pattern is resolved to the current parent model exactly as native launches do, and the command refuses only when no parent model identity is available), other agents' rules, `enabledModels`, provider-preference maps, and every unrelated key are preserved.
- The command fails with an actionable message and writes nothing when a model is missing from this session's model registry; when it is outside the enforced global allow-list; when `subagents.agentOverridesByProvider.<provider>.code-writer` in the user or effective project file sets a launch-relevant field (native layers only the *parent's* provider map, but that changes with `/model`, so any provider map touching the writer is refused conservatively and named exactly; provider preferences are never edited); when the effective project file overrides `code-writer`; or when the effective project file defines `subagents.modelScope`. A project `modelScope` **replaces** the user scope entirely, so the strict per-agent rule written here would be inert; the error prints the matching strict `modelScope.agents.code-writer` rule for the human to add to the project file by hand. Only when the project already carries an equivalent enforced strict writer rule (same model set) is the write accepted, with a warning. Project files are never edited. This is native child model policy, not a parent sandbox.
- The effective project file is resolved with native pi-subagents semantics (mirrored from the installed 0.66.0 `findConfiguredProjectRoot`, checked by the opt-in fixture): ancestor directories containing `.pi/` or `.agents/` are candidates, the nearest wins unless a candidate's `subagents.projectRootResolution` is `git-root`, and an unsupported policy value fails closed. Rebranded config-directory names are not supported. `status`, `models` and `on` all use the same resolution.
- `extensions` is always explicit. The toolkit's own `anthropic-claude-code` provider is added automatically when an `anthropic-claude-code/*` model is in the chain; built-in Pi providers need nothing; any other custom provider is refused with instructions to configure its extension path by hand rather than loading all ambient extensions. Native semantics reported by `status`: a missing `extensions` override inherits the packaged role's explicit empty list (no ambient extensions); `[]` explicitly disables ambient loading; `false` clears the explicit list and lets the child load ambient extensions.
- Writes are a locked transaction that cooperates with Pi's own settings lock (the same `<file>.lock` directory protocol as `proper-lockfile` with `realpath: false`; ten 20 ms attempts). The command **never takes over, refreshes or deletes a lock it did not create**: any pre-existing lock, fresh or stale, is a refusal with no write (remove an abandoned lock by hand if you are sure). Its own lock is remembered by inode/timestamps; if that lock is replaced or removed by another process, or 10 s pass before the commit, the write is abandoned and the successor's lock is left alone. Holding the lock, the file is snapshotted (inode, owner, mode, size, mtime, bytes), the plan is computed from that content, a same-directory temp file is written, and the snapshot and lock ownership are re-checked **immediately before the atomic `rename`** (mode preserved). Any replacement, in-place modification, or creation of an initially absent file in the meantime is refused; the plan itself always sees the bytes read under the lock, so unrelated concurrent edits made before the lock was taken are preserved. Symlinked settings paths and settings directories reachable only through an alias are refused outright (their real target could carry a different native lock); files owned by another user, malformed JSON, non-object roots and unsupported `subagents` layouts are refused, leaving the bytes unchanged. Temp files and the owned lock are removed on every failure; reads and writes are bounded at 1 MiB. Only the two entries above are created when the file is missing. This is race-aware cooperation with Pi's writer, not a sandbox against an adversarial filesystem.
- Validation before any write covers the bounded subset of the native schema this feature reads or writes, in both the user and the effective project file: `modelScope` and every `modelScope.agents.*` rule (boolean `enforce`/`strict`, non-empty string `allow`, no nested `agents`, `enforce` requires an allow-list, and agent names that are unique **after trimming**, because native trims scope keys and lets a later duplicate win; a padded `code-writer` key is refused rather than rewritten); the `agentOverrides` / `agentOverridesByProvider` containers; every field of a `code-writer` override entry in any layer (`model`, `thinking`, `fallbackModels`, `extensions`, `fast`, `disabled`, `defaultContext`, `defaultProvider`, `tools` incl. `"inherit"`/`false`, `excludeTools`, `skills`, `defaultReads`, `subagentOnlyExtensions`, `mutationTools`, `inheritProjectContext`, `inheritGlobalContext`, `inheritSkills`, `allowNestedSubagents`, `completionGuard`, `description`, `output`, `outputMode`, `systemPromptMode`, `systemPrompt`, `acceptanceRole`, `toolBudget`, with the types the installed 0.66.0 `parseBuiltinOverrideEntry` accepts) so preserved user values cannot make the next `/reload` reject the file; and `projectRootResolution`. Accepted values are preserved untouched, never removed. It is **not** a complete native settings validator: other agents' overrides, global subagent options, and unrelated fields are neither checked nor repaired. Native does not trim `agentOverrides` / `agentOverridesByProvider` keys, so nothing is normalised there.
- Changes affect **future** child launches after `/reload`; running children and the parent model are unaffected.

### Routing mode

`/code-writer on` first checks, read-only, that the configuration **as it currently stands** would launch the writer on the stored hierarchy — nothing is planned or repaired: the user file and the effective project file (native project root; unsupported root policy fails closed) must pass the bounded schema validation; the stored override must not be `disabled`, must have `fallbackModels`/`extensions` not set to `false`, must parse as a usable hierarchy and carry every provider extension that hierarchy needs; no `agentOverridesByProvider` map may touch the writer; the hierarchy must be inside the enforced global scope (`inherit` resolved to the current parent model); the project file must not override the writer; and the **effective** writer scope rule (the project's if a project `modelScope` exists, otherwise the user's) must be enforced, strict and equal to the stored hierarchy's model set. The check runs before the dialog (which shows the hierarchy in effect) and again after approval, so a configuration change during the dialog refuses activation with routing unchanged; benign unrelated changes are preserved. `/code-writer off` remains available as a confirmed opt-out regardless of configuration state.

`/code-writer on` is an honestly labelled *preference*, not a sandbox. It appends a marked section to the parent system prompt asking the parent to route source/test edits to `subagent({ agent: "code-writer", … , context: "fresh", async: true })`, to write a coherent bounded task rather than prewritten edit calls, to omit per-call `model` so the configured hierarchy owns selection, to keep decisions/tests/review itself, never to silently fall back to editing directly, and to honour an explicit user opt-out. The parent's own `edit`, `write` and `bash` tools stay enabled; blocking two tools would not stop shell writes, and this slice does not pretend otherwise.

The preference is persisted as a Pi custom entry (`toolkit.code-writer/routing-v1`) and restored from the **active branch** (`sessionManager.getBranch()`, not `getEntries()`, which spans every tree branch) on every `session_start` — startup, `/new`, `/fork`, `/resume`, `/reload` — and again on `session_tree` after `/tree` navigation. The mocked tests cover these hooks with branch fixtures; they do not exercise the live SDK lifecycle. The extension registers nothing inside subagent child processes (`PI_SUBAGENT_CHILD=1`), so the parent-only policy does not propagate into children.

## Native fallback contract

Fallback is native pi-subagents behaviour; the toolkit does not run a parallel runner, catch failures, or replay tasks.

- Automatic fallback to the next hierarchy model happens for retryable provider/model failures — rate limit, quota, overload, unavailable model, provider timeout — **before any tool activity**.
- No fallback after tool activity, on cancellation or the run deadline, on ordinary task or test failure, or for unsupported setups. (The narrow native read-only HTTP 429 continuation does not apply to this writer.)
- After partial work, the parent must report the run/worktree state, inspect and preserve the diff, and deliberately issue a **new continuation task** for the remaining work on a remaining approved model — without replaying completed changes. A retained native resume keeps its original model; it is not cross-model continuation.
- Because models on one provider often share a quota, cross-provider backups (for example Fable → Astra → Luna) are more useful than same-provider ones.
- Do not pin a per-run `model` in `subagent` calls: an explicit model is strict, does not rotate, and can collide with cached exclusions that configured origins skip.

## Tests

`bun test ./extensions/code-writer tests/extensions/code-writer-package.test.ts` runs hermetically with temporary homes and fake contexts. `tests/extensions/code-writer-native.test.ts` is skipped unless `CODE_WRITER_NATIVE_ROOT` points at an installed pi-subagents root; it then checks the serialised override against that package's pure `buildModelCandidates`/scope functions, native `inherit` resolution, native scope-key trimming (collision fixtures rejected here, the written rule parsing to the same allow-list), and `findConfiguredProjectRoot` on ancestor/git-root fixtures, without launching agents or models. The native override-entry parser is not exported, so writer-field types are mirrored from the inspected source rather than compared live. Its environment and scratch setup live in guarded lifecycle hooks and are restored afterwards; skipped registration has no side effects. Live fallback is not exercised anywhere.
