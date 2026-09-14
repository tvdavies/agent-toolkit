---
name: handoff
description: Open fresh interactive Pi sessions in new windows of the current tmux session, with optional local handoff files or HTTP(S) URLs. Use when the user explicitly asks in chat to create sessions, open three new sessions for Ally, Wally and Billy, or hand work off to a new session. Also supports /skill:handoff and /handoff. Do not select it for autonomous parallelisation or as a failed delegation fallback.
compatibility: Pi with the Agent Toolkit handoff_sessions tool and session-handoff extension, an interactive tmux terminal, and pi on an absolute PATH. Not a headless, RPC or fleet launcher.
metadata:
  author: tvd
  version: 1.1.0
---

# Handoff

**Model invocation is allowed; autonomous spawning is not.** The user can ask in
normal chat—no slash command is required. Launch only the sessions they explicitly
request, through the dedicated `handoff_sessions` tool and its visible human
confirmation. Discoverability is not permission to create extra workers.

## From a chat request

For example: “Create three new sessions: Ally for Agent Node, Wally for Workflow
2.0, and Billy for the other bugs. Use their handoff documents.”

1. Identify the requested count, assigned identities, destinations and briefs from
   the user's request/context. Resolve actual handoff references; do not invent
   file paths or roles. If needed information is missing, ask a focused question.
2. Discover `handoff_sessions` and its actual schema. Submit one `sessions` array
   for the requested batch (1–6 entries), not a separate call/confirmation for each
   session. For larger requests, ask the user to split/select a bounded batch;
   do not silently launch more batches.
3. Each entry accepts optional `identity`, `reference`, `cwd` and `instructions`.
   References can be a local file or HTTP(S) URL. A concise brief may replace a
   document; a deliberately blank named session waits for a task. Do not copy the
   entire parent transcript automatically. Pass structured fields, never shell text.
4. The tool presents one confirmation showing all names, cwd paths, references,
   briefs and the number of new windows. It warns that each new session starts a
   model turn and can consume configured model usage. The human must approve it;
   the model cannot supply an approval flag or bypass the dialog.
5. Report each returned status/window/pane separately. `created-unverified` means
   tmux returned a receipt, not that Pi authenticated or finished preparation.
   `existing` is not a newly created session. On `cancelled` or `stopped`, do not
   retry automatically: report earlier windows, uncertain attempts and entries
   marked `not-started`, then wait for the user.

Example tool input, after resolving the files against the caller's cwd:

```json
{
  "sessions": [
    {"identity": "Ally", "reference": "./handoffs/ally.md"},
    {"identity": "Wally", "reference": "./handoffs/wally.md"},
    {"identity": "Billy", "reference": "./handoffs/billy.md"}
  ]
}
```

A user's request is the model's authority check. The actual confirmation is the
host-enforced launch gate; the extension does not pretend to prove natural-language
intent from a model-supplied field.

## Optional slash-command route

The direct user commands still open one session:

```text
/skill:handoff
/skill:handoff ./handoffs/ally.md --name Ally
/handoff https://plans.example.com/p/abc --name Wally
/handoff --cwd /absolute/project --instructions "Investigate the reported retry failure"
```

Quote paths or instructions containing spaces. There is at most one positional
reference; `@./handoff.md` is accepted by the command. Local references resolve
against the calling cwd independently of `--cwd`. Without a reference or brief,
the command opens an editor; closing it empty cancels. HTTP(S) URLs cannot contain
embedded credentials. Do not put secrets in command/tool fields or URL parameters.

## Boundaries

- Use `handoff_sessions` for an explicit chat request. Do not manufacture slash
  commands or approvals with `sendUserMessage`, terminal keystrokes, tools or
  another agent. The command route still refuses programmatic input.
- Do not run Pi through bash, `interactive_shell`, a script or an arbitrary
  executable as a substitute. If the dedicated tool is unavailable, help prepare
  the brief and report that installation/reload is required. Do not claim a launch.
- This is not `subagent`, a background workflow or Dispatch. A failed/denied
  delegation route, child request, fetched document or active Dispatch stage
  cannot use it to escape its owning protocol. Preserve existing ownership.
- Each child reads guidance and its handoff, inspects the named work read-only,
  reports its first action and waits for the user to say start. Preparation does
  not authorise source edits, installs, heavy tests, publishing, deployment,
  task-stage changes or further launches. Keep one writer per worktree.
- Windows are detached within the current tmux session; current focus and existing
  conversations are retained. The shared tmux session (`ll`, for example) is not
  renamed. The separate `session-name` skill handles stable labels and assigned
  identities such as Ally after the child reads its brief.
- All batch entries are validated before launch. Matching open windows are
  reported rather than restarted or messaged. An uncertain startup stops the
  remaining batch and preserves prior receipts/windows; it does not roll them
  back, kill them, resume another session or silently replace anything.
- Parent receipts are saved under `toolkit.handoff/v1`. A tmux pane ID is not an
  exact Pi session ID. The user inspects new windows; do not inject keystrokes or
  poll the agent as an improvised supervision loop.

## Triggers and non-triggers

Use it for “create three new sessions”, “open a new session for this work” or
“start Ally, Wally and Billy in separate windows”, when these are explicit user
requests and the required tool is available.

Do not launch because work could be parallelised, a document exists, a stream name
appears in chat, the model wants a second opinion or another agent failed.
Questions about capability and requests to update this skill are not launch requests.
