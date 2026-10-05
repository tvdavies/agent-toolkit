# Delegation policy

This extension appends delegation guidance in `before_agent_start`. It is prompt
policy, not a shell-command parser or runtime permission gate.

## Approved routes

- `subagent`: delegated agent work.

Never use `interactive_shell`, `bash`, or another general shell tool to launch,
invoke, communicate with, or delegate to an AI agent harness (Pi, Claude Code,
Codex, Cursor, Gemini, Aider, and similar). If an approved route is unavailable
or fails, report the blocker and work inline or ask the user; do not silently
switch execution routes.

## Updating the installed policy

The Agent Toolkit local Pi package loads this file from its installed checkout.
After applying a change there, run `/reload` in each affected Pi session or
restart Pi. New sessions load the updated extension; an existing session must
reload or restart before relying on it. Editing the source does not change the
instructions already in force in a running turn.

## Validation

```sh
bun test ./extensions/delegation-policy/index.test.ts
```

These tests check prompt injection, deduplication, and the wording of the
approved routes and shell-launch boundary. They do not run Pi or call a model.
