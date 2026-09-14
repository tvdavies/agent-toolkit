# Manual handoff and stable session naming

Two independent, model-discoverable skills share one extension. `handoff` responds
to explicit user requests in chat using `handoff_sessions`; `session-name` responds
at meaningful naming points. Model invocation is allowed, autonomous spawning is
not. The launcher requires human confirmation, whether reached through the batch
tool or a direct slash command. Skill discoverability is not an OS security boundary.

## Install and activate

Run the repository's `scripts/sync.sh` from the intended checkout and `/reload` in
active Pi sessions. Skills live in `skills/general/`; the package loads this
extension through `index.ts`. No service, scheduler, third-party dependency or
model/provider configuration is added. Test dependencies use the repository's
normal npm lockfile. Do not replace an installed checkout with a temporary
worktree if that would discard unrelated local provider/policy changes.

The implementation uses Pi APIs available in the declared 0.75.5 development
dependency. Launching requires tmux's direct multi-argument `new-window` execution
and `-e` environment support. It passes one fixed-prefix prompt, not `--`, which
older supported Pi parsers interpret as an unknown flag and swallow with its value.

## Chat and commands

The user can say: “Create three new sessions: Ally for Agent Node, Wally for
Workflow 2.0, and Billy for the other bugs. Use their handoff documents.”

The model reads `handoff` and calls `handoff_sessions` once with a `sessions` array
of 1–6 objects. Each accepts optional `identity`, `reference`, `cwd` and
`instructions`. The tool normalises structured fields directly, validates the
entire batch, then presents one confirmation listing all entries and the number
of new windows. No approval flag, arbitrary executable or tmux target is accepted.
Combined fields are capped at 24,000 characters; handoff documents remain references,
not copied file contents. A blank named entry waits for a task.

These optional direct commands still open one session (or change a label):

```text
/skill:handoff
/skill:handoff "./handoffs/agent node.md" --name Ally
/handoff https://plans.example.com/p/123 --cwd /absolute/repository
/handoff --instructions "Inspect the failing retry and report the first action"
/session-label --identity Ally --topic "Agent Node"
/session-label
```

`handoff` options are `--name`, `--cwd`, `--instructions` and one optional local
file or HTTP(S) URL. No reference/brief opens an editor; an empty result cancels.
Relative files resolve against the caller's cwd, not `--cwd`. File contents are
not copied into the command, and URLs are not fetched by the launcher. The child
reads/fetches the reference under its existing tool permissions. Do not put secrets
in the brief or URL: arguments, the confirmation and normal Pi transcript can
contain the supplied context.

`--name` is the assigned identity in the child brief, not a direct session-file
edit or an identity inferred from remote content. The naming tool subsequently
sets `Ally - Agent Node`, for example. A temporary `handoff-<key>` window name is
used until preparation can establish the meaningful label.

## Launch boundary

- The model-callable `handoff_sessions` tool works during an active model turn;
  requiring `ctx.isIdle()` there would prevent chat use. It still requires a human
  TUI and verified current tmux pane. A shared in-flight guard excludes overlapping
  tool/command dialogs, and tool calls use sequential execution mode.
- `/skill:handoff` is intercepted before skill expansion, only for direct
  interactive input. Extension/RPC command injection is refused; the model should
  use the dedicated tool, not fabricate slash commands. `/handoff` is equivalent.
  The command route additionally requires an idle session.
- One confirmation discloses every entry and that each new session starts a model
  turn and can consume configured usage. An explicit user request is the model's
  authority check; the confirmation is the host-enforced gate. The extension does
  not attempt to infer user intent from a model-authored assertion. Cancellation
  authorises nothing. No model, provider, trust, billing or context settings are
  changed. No background/fleet mode, timer, automatic retry, resume or shell fallback
  exists. Active Dispatch-stage processes are refused.
- The process's terminal device must match `#{pane_tty}` for `TMUX_PANE`.
  An inherited pane environment in a headless child or overlay is insufficient.
- `tmux new-window -d` uses an absolute Pi executable, the validated cwd and direct
  argv: no `sh -c`, `send-keys`, `pi -c`, arbitrary executable, arbitrary target or
  instructions injected into an existing conversation. It leaves focus unchanged.
- The parent writes `toolkit.handoff/v1` before launch, then records the window and
  pane IDs. Window metadata retains a request key even if the child changes its
  visible label. Matching open windows are reported rather than reused/restarted.
- A returned receipt is `created-unverified`, not authenticated/ready/completed.
  A failure or timeout after the first mutation records an `unknown` outcome;
  a repeated request in that parent is held for human inspection. Batch results
  distinguish `existing`, `created-unverified`, `unknown` and `not-started` entries.
  A partial failure stops the rest immediately, preserving earlier windows and
  receipts rather than rolling them back or replaying the batch. Abort signals are
  checked before approval and between launches; an already-started mutation is
  recorded before stopping. No window is killed or silently replaced. The child
  can still fail while loading/authenticating; inspect its window. A tmux pane
  receipt is not an exact Pi session ID.

This specific tool is a permitted manual-conversation handoff route for an explicit
user request, not permission to bypass `subagent`, workflows or Dispatch ownership
for autonomous work or a denied/failed delegation fallback. The companion policy
change describes the same narrow boundary; do not broaden it to generic shell
launches, extra unrequested sessions or authority granted by a fetched document.

## Naming boundary

`set_session_name` accepts optional `identity` and `topic`; it has no tmux target,
command, prompt, process or session-file argument. It:

1. preserves/pins an explicitly assigned identity;
2. uses `pi.setSessionName` and a `toolkit.session-name/v1` custom entry, read on
   subsequent calls/resume/reload rather than cached across sessions;
3. leaves an identical label untouched;
4. refuses replacement of a pinned identity, unmanaged manual names, or subsequent
   `/name` overrides unless the user confirms `/session-label`;
5. rate-limits automatic topic changes to ten minutes (adding a newly assigned
   identity is allowed sooner), with no scheduled retry;
6. renames only its verified, single-pane, unlinked window and disables automatic
   naming there; global tmux settings and the containing session remain untouched.

Without a safe tmux target, the Pi label can still succeed with a warning. A window
renaming error can leave a partial result (Pi named, window not named); it does not
roll back or target another window. Existing tools are not removed from Pi: this
extension constrains its own surface, rather than claiming to sandbox arbitrary
third-party extensions or a human with terminal access.

## Validation

```bash
npm ci
npm run typecheck
bun test ./extensions/session-handoff ./extensions/delegation-policy
npm test
```

All launch/naming tests inject mock terminal and process runners. They do not start
Pi, authenticate, spend model usage, change real tmux state or run a live child.
They cover an in-turn three-session tool call with one confirmation, command-source
gating, whole-batch validation, direct argv, optional references, partial-failure
receipts, duplicate/uncertain attempts, aborts, concurrent dialog refusal, persisted
naming state, identity/manual-name protection, cooldown and shared/inherited-pane
refusal. Static skill/policy tests check discoverability and explicit-request
instructions, not semantic intent detection or model obedience. A real end-to-end
launch remains an explicit human acceptance check after installation/reload, not
an automated test.
