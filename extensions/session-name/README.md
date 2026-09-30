# Stable session naming

The model-discoverable `session-name` skill labels the current Pi session and its
own tmux window at meaningful naming points, through `set_session_name`. The user
can override it with `/session-label`. It never launches, resumes, prompts or
terminates another session.

## Install and activate

Run the repository's `scripts/sync.sh` from the intended checkout and `/reload` in
active Pi sessions. The skill lives in `skills/general/session-name/`; the package
loads this extension through `index.ts`. No service, scheduler, third-party
dependency or model/provider configuration is added.

## Commands

```text
/session-label --identity Ally --topic "Agent Node"
/session-label
```

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
bun test ./extensions/session-name ./extensions/delegation-policy
npm test
```

Naming tests inject mock terminal and process runners. They do not start Pi or
change real tmux state. They cover persisted naming state, identity/manual-name
protection, cooldown and shared/inherited-pane refusal. Static skill tests check
the skill contract, not model obedience.
