# code-writer

A dedicated native [pi-subagents](https://github.com/nicobailon/pi-subagents) code-writing role for **substantive** patches, whose model is chosen independently of the parent session, with one human-selected model. Native pi-subagents 0.68+ does not support automatic model fallback. The parent keeps product/architecture decisions, coordination, test execution, final acceptance and, when justified, an independent `reviewer` pass; genuinely mechanical edits and bounded reading may go to the existing cheaper roles (see [Routing mode](#routing-mode)).

Inspected against the independently installed native pi-subagents **0.68.0**. The toolkit's bundled pi-subagents 0.28 dependency is used only by the separate workflows adapter and is not upgraded or imported here.

## What is packaged

- `agents/code-writer.md` — advertised, fresh-context, async by default. Tools: `read, grep, find, ls, edit, write, contact_supervisor`. No shell, no nested subagents, no global context or skills catalog; repository instructions are inherited. `acceptance: none` with `acceptanceRole: writer`: completion acknowledges an **unverified patch handoff**; the parent must validate before accepting. The file deliberately sets **no model**: the model hierarchy is deployment configuration.
- `package.json` declares `"pi-subagents": { "agents": ["./agents"] }` so the installed local package exposes the agent (package agents load above builtins and below user/project agents).
- This extension registers one human slash command, a session-scoped routing preference and an opt-in user-level routing default (`codeWriter.routingDefault`). There is **no model-facing setter** and no launcher: launches go through the normal `subagent` tool.

## Activation

```bash
./scripts/sync.sh        # records this checkout as the local Pi package
```

Then in each Pi session: `/reload`, followed by an explicit hierarchy and, if wanted, the routing preference:

```text
/code-writer models anthropic-claude-code/claude-fable-5-1:medium
/reload
/code-writer on
```

To make every brand-new session start in delegation-preferred mode instead of typing `/code-writer on` each time, run `/code-writer default on` once and approve the dialog (see [Routing default](#routing-default)). Nothing is enabled or written on package load; the example above (one medium-thinking model, no fallbacks) is documentation and is never saved unless you type it, and the routing default is `false` until you confirm it. Multi-model hierarchies are refused before confirmation or writing: native 0.68+ removed `fallbackModels`, including empty arrays and `false`. A confirmed single-model reconfiguration removes a legacy writer `fallbackModels` key; it does not migrate other roles. Your default parent model and the other worker roles are untouched.

## Commands

| Command | Effect |
|---|---|
| `/code-writer status` | Session routing state; the **stored** user hierarchy, scope and child extensions; whether **effective** project settings override or replace it; the reload requirement; and the native fallback limits. |
| `/code-writer models <provider/id[:thinking]>` | After a UI confirmation, writes one fully qualified model with an optional `:off|minimal|low|medium|high|xhigh|max` suffix to `~/.pi/agent/settings.json`. Repeating the command replaces the selected model and its strict scope. Requires `/reload` before new launches use it. |
| `/code-writer on` | After a UI confirmation, delegation-preferred routing for this session. Refused, leaving routing unchanged, unless the configuration **as it currently stands** would launch the writer on the stored hierarchy (see below). |
| `/code-writer off` | After a UI confirmation, turns the routing preference off for this session. Records an explicit session choice, so it also opts this branch out of an enabled routing default. |
| `/code-writer default on` | After a UI confirmation, writes `codeWriter.routingDefault: true` to `~/.pi/agent/settings.json` so future parent sessions and branches without an explicit `on`/`off` choice inherit delegation-preferred routing. Refused, writing nothing, unless the packaged agent exists and the configuration **as it currently stands** would launch the writer (same check as `on`). Never changes the hierarchy or the current session's explicit choice. |
| `/code-writer default off` | After a UI confirmation, writes `codeWriter.routingDefault: false`. Works even when the writer configuration is unusable; explicit session choices are untouched. |

`default` accepts exactly one argument, `on` or `off`; anything else prints usage and does nothing.

Every mutating action requires an explicit confirmation dialog in the interactive Pi UI and fails closed without a UI or when declined. This is deliberate: Pi dispatches extension slash commands before source-aware input hooks, so a command name alone does not prove a human typed it (an extension could inject it through `sendUserMessage`). The preview shown in the dialog is computed from a snapshot; the actual write recomputes and revalidates everything under the settings lock.

### What `models` writes

Exactly, and nothing else:

```json
{
  "subagents": {
    "agentOverrides": {
      "code-writer": {
        "model": "anthropic-claude-code/claude-fable-5-1",
        "thinking": "medium",
        "defaultContext": "fresh",
        "fast": false,
        "extensions": ["<this checkout>/extensions/anthropic-claude-code.ts"]
      }
    },
    "modelScope": {
      "agents": {
        "code-writer": { "enforce": true, "strict": true, "allow": ["anthropic-claude-code/claude-fable-5-1"] }
      }
    }
  }
}
```

- A `:thinking` suffix becomes the override's `thinking`. No `fallbackModels` key is written, even when there are no backups.
- The per-agent scope lists **every** hierarchy model and is replaced wholesale on each run; it is command-owned, so a later hierarchy is never validated against it. Scope is enforcement, not routing. Native applies an agent rule's `enforce: true` independently of the global flag. The existing global `modelScope.allow` (immutable here; a literal `inherit` pattern is resolved to the current parent model exactly as native launches do, and the command refuses only when no parent model identity is available), other agents' rules, `enabledModels`, provider-preference maps, and every unrelated key are preserved.
- The command fails with an actionable message and writes nothing when a model is missing from this session's model registry; when it is outside the enforced global allow-list; when `subagents.agentOverridesByProvider.<provider>.code-writer` in the user or effective project file sets a launch-relevant field (native layers only the *parent's* provider map, but that changes with `/model`, so any provider map touching the writer is refused conservatively and named exactly; provider preferences are never edited); when the effective project file overrides `code-writer`; or when the effective project file defines `subagents.modelScope`. A project `modelScope` **replaces** the user scope entirely, so the strict per-agent rule written here would be inert; the error prints the matching strict `modelScope.agents.code-writer` rule for the human to add to the project file by hand. Only when the project already carries an equivalent enforced strict writer rule (same model set) is the write accepted, with a warning. Project files are never edited. This is native child model policy, not a parent sandbox.
- The effective project file is resolved with native pi-subagents semantics (mirrored from the installed 0.66.0 `findConfiguredProjectRoot`, checked by the opt-in fixture): ancestor directories containing `.pi/` or `.agents/` are candidates, the nearest wins unless a candidate's `subagents.projectRootResolution` is `git-root`, and an unsupported policy value fails closed. Rebranded config-directory names are not supported. `status`, `models` and `on` all use the same resolution.
- `extensions` is always explicit. The toolkit's own `anthropic-claude-code` provider is added automatically when an `anthropic-claude-code/*` model is in the chain; built-in Pi providers need nothing; any other custom provider is refused with instructions to configure its extension path by hand rather than loading all ambient extensions. Native semantics reported by `status`: a missing `extensions` override inherits the packaged role's explicit empty list (no ambient extensions); `[]` explicitly disables ambient loading; `false` clears the explicit list and lets the child load ambient extensions.
- Writes are a locked transaction that cooperates with Pi's own settings lock (the same `<file>.lock` directory protocol as `proper-lockfile` with `realpath: false`; ten 20 ms attempts). The command **never takes over, refreshes or deletes a lock it did not create**: any pre-existing lock, fresh or stale, is a refusal with no write (remove an abandoned lock by hand if you are sure). Its own lock is remembered by inode/timestamps; if that lock is replaced or removed by another process, or 10 s pass before the commit, the write is abandoned and the successor's lock is left alone. Holding the lock, the file is snapshotted (inode, owner, mode, size, mtime, bytes), the plan is computed from that content, a same-directory temp file is written, and the snapshot and lock ownership are re-checked **immediately before the atomic `rename`** (mode preserved). Any replacement, in-place modification, or creation of an initially absent file in the meantime is refused; the plan itself always sees the bytes read under the lock, so unrelated concurrent edits made before the lock was taken are preserved. Symlinked settings paths and settings directories reachable only through an alias are refused outright (their real target could carry a different native lock); files owned by another user, malformed JSON, non-object roots and unsupported `subagents` layouts are refused, leaving the bytes unchanged. Temp files and the owned lock are removed on every failure; reads and writes are bounded at 1 MiB. Only the two entries above are created when the file is missing. This is race-aware cooperation with Pi's writer, not a sandbox against an adversarial filesystem.
- Validation before any write covers the bounded subset of the native schema this feature reads or writes, in both the user and the effective project file: `modelScope` and every `modelScope.agents.*` rule (boolean `enforce`/`strict`, non-empty string `allow`, no nested `agents`, `enforce` requires an allow-list, and agent names that are unique **after trimming**, because native trims scope keys and lets a later duplicate win; a padded `code-writer` key is refused rather than rewritten); the `agentOverrides` / `agentOverridesByProvider` containers; every field of a `code-writer` override entry in any layer (`model`, `thinking`, `fallbackModels`, `extensions`, `fast`, `disabled`, `defaultContext`, `defaultProvider`, `tools` incl. `"inherit"`/`false`, `excludeTools`, `skills`, `defaultReads`, `subagentOnlyExtensions`, `mutationTools`, `inheritProjectContext`, `inheritGlobalContext`, `inheritSkills`, `allowNestedSubagents`, `completionGuard`, `description`, `output`, `outputMode`, `systemPromptMode`, `systemPrompt`, `acceptanceRole`, `toolBudget`, with the types the installed 0.66.0 `parseBuiltinOverrideEntry` accepts) so preserved user values cannot make the next `/reload` reject the file; and `projectRootResolution`. Legacy writer `fallbackModels` arrays or `false` are accepted only for removal during explicit single-model reconfiguration; activation refuses their presence. Other accepted values are preserved unless owned by the command. It is **not** a complete native settings validator: other agents' overrides, global subagent options, and unrelated fields are neither checked nor repaired. Native does not trim `agentOverrides` / `agentOverridesByProvider` keys, so nothing is normalised there.
- Changes affect **future** child launches after `/reload`; running children and the parent model are unaffected.

### Routing mode

`/code-writer on` first checks, read-only, that the configuration **as it currently stands** would launch the writer on the stored hierarchy — nothing is planned or repaired: the user file and the effective project file (native project root; unsupported root policy fails closed) must pass the bounded schema validation; the stored override must not be `disabled`, must have no `fallbackModels` key and must not set `extensions` to `false`, must parse as a usable hierarchy and carry every provider extension that hierarchy needs; no `agentOverridesByProvider` map may touch the writer; the hierarchy must be inside the enforced global scope (`inherit` resolved to the current parent model); the project file must not override the writer; and the **effective** writer scope rule (the project's if a project `modelScope` exists, otherwise the user's) must be enforced, strict and equal to the stored hierarchy's model set. The check runs before the dialog (which shows the hierarchy in effect) and again after approval, so a configuration change during the dialog refuses activation with routing unchanged; benign unrelated changes are preserved. `/code-writer off` remains available as a confirmed opt-out regardless of configuration state.

`/code-writer on` is an honestly labelled *preference*, not a sandbox and not an enforced complexity classifier. It appends a marked section to the parent system prompt that splits delegated work by kind:

| Work | Role | Notes |
|---|---|---|
| Bounded reading: callers, coverage, a named review question | `review-evidence` / `scout` | Evidence only; never approval or a decision. |
| Mechanical edits only: settled behaviour, explicit file scope, an existing pattern to propagate exactly, cheap verification | `routine-worker` | If it is unclear whether work is mechanical, it is not; it goes to the writer. |
| Substantive implementation and tests; any coding needing judgement beyond that gate | `code-writer` | `subagent({ agent: "code-writer", … , context: "fresh", async: true })`, a coherent bounded task rather than prewritten edit calls, no per-call `model`. |
| Independent review of consequential changes when useful or required | `reviewer` | Not an obligatory stage for every patch; informs but never replaces parent acceptance. |

Product/architecture decisions, coordination, command and test execution and final acceptance stay with the parent. The addendum asks for enough delegated reading to avoid duplicated work without a mandatory scout-plan-write-review ceremony, one writer per checkout, fresh unpinned launches for every role, honest reporting of the route taken, explicit partial-work continuation instead of task replay, and never to silently fall back to editing directly (tiny explicitly requested non-code edits excepted). Roles are chosen from the agents actually available in the session: an unavailable or unsuitable role is reported and the user asked, never replaced by a cheaper worker. The parent's own `edit`, `write` and `bash` tools stay enabled; blocking two tools would not stop shell writes, and this slice does not pretend otherwise. The named non-writer roles are existing user/builtin agents; this extension does not install, configure or launch them, and it changes no native launch protocol.

The preference is persisted as a Pi custom entry (`toolkit.code-writer/routing-v1`) and restored from the **active branch** (`sessionManager.getBranch()`, not `getEntries()`, which spans every tree branch) on every `session_start` — startup, `/new`, `/fork`, `/resume`, `/reload` — and again on `session_tree` after `/tree` navigation. The mocked tests cover these hooks with branch fixtures; they do not exercise the live SDK lifecycle. The extension registers nothing inside subagent child processes (`PI_SUBAGENT_CHILD=1`), so the parent-only policy does not propagate into children.

### Routing default

`codeWriter.routingDefault` is a single boolean in the **user** settings file (`~/.pi/agent/settings.json`), owned by this extension and ignored by native pi-subagents. Absent means `false`, so existing users see no change; the package never ships it as `true`. It is written only by `/code-writer default on|off` after a confirmation dialog, through the same locked transaction as `models`: the file is snapshotted under the lock, only `codeWriter.routingDefault` is set (unknown sibling keys inside `codeWriter`, the whole `subagents` tree, model/role/global policy and every other key are carried over untouched), and the write is abandoned if the file changed underneath, is locked, symlinked, malformed, or has a non-object root. A non-object `codeWriter` or a non-boolean `routingDefault` (for example the string `"true"`) is refused rather than coerced or overwritten. Only the flag is created when the file is missing.

`default on` additionally requires the packaged agent file and passes the same read-only activation check as `/code-writer on` before the dialog (which shows the file, the scope — future parent sessions and branches without an explicit choice — the hierarchy in effect and any warnings) and again — including the packaged agent file check — on the locked file content with freshly read effective project policy before writing. A conflicting configuration or project change while the dialog is open blocks the write; benign unrelated changes survive. `default off` needs no usable writer: it only disables the owned flag. Neither command touches the hierarchy, the model scope or the session's explicit choice.

**Precedence.** The last valid routing entry on the active branch wins, whether `true` or `false`. Only a branch without an explicit choice inherits the stored default, which is never materialised as a session entry and never written back. `/code-writer on` and `off` remain session-only, so `off` opts a branch out even while the default is on, and changing the default never replaces an explicit session choice. Effective routing is re-evaluated when each parent turn is prepared (`before_agent_start`) from the active branch, the current user default and the current stored/effective writer configuration; `/code-writer status` reports the same resolution: the stored default (on, off, or unreadable/invalid with its reason — an unreadable value is never reported as off, even while an explicit session choice is in force), whether the current routing is an explicit session choice or inherited, the effective state and any blocking reason. An inherited preference is never labelled as a manual `/code-writer on`: the addendum keeps the same marker (so it is still appended once), its heading and opening sentence name the source (session choice or inherited default), and the policy body that follows is identical.

**Fail closed.** A default that is enabled but cannot activate here — missing agent file, missing or disabled writer override, malformed relevant configuration, a writer scope rule that is missing or not enforced strict, an unsupported provider/project layout or an effective project conflict, an unreadable file or an unsupported flag type — adds no addendum, repairs nothing, appends nothing and never throws at startup. The reason is shown once per distinct reason as a warning when a turn is prepared and always in `status`. Explicit session decisions keep their existing behaviour. Project settings still decide whether the writer can activate; they neither supply nor override `codeWriter.routingDefault`, which is read from the user file only. Subagent children (`PI_SUBAGENT_CHILD=1`) register nothing regardless of the flag.

## Native single-model contract

Native pi-subagents 0.68+ resolves one model per launch. Provider failures, including quota and rate-limit errors before any tool activity, are reported rather than retried on another model. The toolkit does not run a parallel runner, catch failures, or replay tasks.

After partial work, report the run/worktree state and inspect and preserve the diff. Ask the user before a new continuation on another approved model; never replay completed changes or silently downgrade to a cheaper role. A retained native resume keeps its original model.

Do not pin a per-run `model` in ordinary `subagent` calls: use the configured model and its human-approved scope.

## Tests

`bun test ./extensions/code-writer tests/extensions/code-writer-package.test.ts` runs hermetically with temporary homes and fake contexts, including the routing-default precedence, confirmed default writes and fail-closed inheritance fixtures. `tests/extensions/code-writer-native.test.ts` is skipped unless `CODE_WRITER_NATIVE_ROOT` points at an installed pi-subagents root; it then checks single-model settings through native discovery in a temporary agent directory, scope enforcement, native `inherit` resolution, scope-key trimming and `findConfiguredProjectRoot`, without launching agents or models. The native override-entry parser is not exported, so writer-field types are mirrored from the inspected source rather than compared live. Its environment and scratch setup live in guarded lifecycle hooks and are restored afterwards; skipped registration has no side effects. Live fallback is not exercised anywhere.
