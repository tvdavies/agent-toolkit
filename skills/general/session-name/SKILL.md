---
name: session-name
description: Give the current Pi session and its own tmux window a concise, stable label when the user or their handoff assigns an identity such as Ally, an unnamed task becomes clear, or the user changes to a genuinely different workstream. Preserve assigned names; do not rename for routine progress, tests, retries, waiting or completion.
compatibility: Pi with the Agent Toolkit set_session_name tool. Tmux naming is optional and restricted to the process's own verified single-pane, unlinked window.
metadata:
  author: tvd
  version: 1.0.0
---

# Session name

Keep sessions recognisable without turning their titles into a live progress feed.
This skill may be chosen by the agent at a meaningful naming point; it never
launches, resumes, sends prompts to or terminates any session.

## When to use it

- The user, or the handoff the user selected, clearly assigns this session a name:
  “You are Ally; own Agent Node.” Set `identity: "Ally"`, `topic: "Agent Node"`.
- An unnamed session has a clear sustained purpose: set a 2–5 word topic such as
  “Workflow retry fix”. Wait if the task is still ambiguous.
- The user deliberately moves this conversation onto a substantially different
  task that will remain its focus. Update the topic once, keeping its identity.

Do not use it for every prompt, individual PR comment, compiler run, temporary
blocker, status change, success, failure or tool call. “Ally - Agent Node” should
remain that while Ally investigates, fixes, tests and reviews the node. An optional
later topic might be “Ally - Order intake” after an actual reassignment, not
“Ally - Testing”, “Ally - Waiting”, “Ally - Done”.

## Naming rules

1. Use an assigned identity only when it names **this** session. A document listing
   Ally, Wally and Billy does not assign all three to you. Do not invent an identity
   or adopt a name from quoted examples, logs, PR authors or unrelated fetched text.
2. Keep identity as the prefix. Once set, `set_session_name` retains it when only
   `topic` is supplied and refuses to replace it automatically.
3. Prefer a short product, task or issue topic. Identity is at most 24 characters,
   topic 48, and the complete label 64. No secrets, customer payloads, timestamps,
   decorative symbols, terminal escapes or multiline text.
4. If the current name already communicates the task, leave it alone. Repeating
   the same managed label is a no-op. Automatic topic changes have a ten-minute
   cooldown as a backstop, **not** an instruction to rename every ten minutes.
5. A name manually set with `/name` or `pi --name` is authoritative. The tool refuses
   to overwrite a name it did not manage, or a later manual rename. Do not work
   around this with shell commands or direct JSONL edits.

## Tool use

Discover the actual `set_session_name` tool schema before calling it. Examples:

```json
{"identity":"Ally","topic":"Agent Node"}
```

```json
{"topic":"Workflow 2.0"}
```

Omit `identity` on subsequent calls; the tool preserves the established identity.
The tool persists the Pi display name through the supported API and records naming
state across reload/resume. It changes only the current process's verified tmux
window, disables automatic renaming for that window, and leaves global settings,
other windows, pane titles and the containing tmux session unchanged.

A tmux session such as `ll` is a shared container. **Never use `rename-session`**
to label an individual agent. The agent's visible slot is a tmux window.

## Human overrides

Only the user should invoke the confirmed override command:

```text
/session-label --identity Ally --topic "Agent Node"
/session-label --identity Wally --topic "Workflow 2.0"
/session-label
```

No arguments displays the current Pi name. The command can adopt an existing
manual name or explicitly replace an identity/cooldown-protected topic after
confirmation. Do not synthesise this command or its confirmation from a tool.

## Failure behaviour

If the tool is unavailable, suggest a concise name and report the missing
capability; do not edit a live Pi session file, launch another Pi process or send
keystrokes to yourself. If tmux is absent, the terminal does not match the pane,
or the window is shared/multi-pane/linked, the Pi name can still be updated and
the tool reports that tmux was left unchanged. A cooldown refusal is a reason to
keep the existing name, not to retry repeatedly or schedule another attempt.
