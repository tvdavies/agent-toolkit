---
name: claims
description: Atomic cross-session claims (leases) so two agent sessions never work the same ticket, PR or red-main fix. Use before starting a Linear ticket, before fixing a red main branch, before taking over a PR, and whenever start-ticket, yolo-ticket, the PR-readiness protocol, workstream or sweep say to claim, renew or release. Covers the `claim` CLI, key and holder-label conventions, and what to do when a claim is held.
compatibility: Requires Node.js 22.13 or later (node:sqlite).
metadata:
  author: tvd
  version: 1.0.0
---

# Claims

Every session acts in Linear and GitHub as Tom, so "In Progress, assigned to Tom"
can't tell sessions apart. A claim can. Linear stays the signal people see; the
claim is the lock.

## The CLI

Run `claim` if it is on PATH, otherwise `~/.agents/skills/claims/scripts/claim`
(`$SKILL_DIR/scripts/claim`). To put it on PATH:
`ln -s ~/.agents/skills/claims/scripts/claim ~/.local/bin/claim`.

```bash
claim acquire <key> --holder <label> [--ttl 15m] [--note text]
claim renew <key> --holder <label> [--ttl 15m] [--note text]
claim release <key> --holder <label>
claim release-all --holder <label>
claim show <key>
claim list [--stale]
claim steal <key> --holder <label> --reason <text>
```

Every command takes `--json`. Exit codes:

- `0`: done. Acquiring a key you already hold renews it.
- `3`: held by someone else. The output shows the holder, note, when it was
  acquired and last renewed, and when it expires.
- anything else: the claims tool is broken. **Fail open**: say so in your report
  and carry on, relying on the Linear and GitHub checks. Never block on it.

Leases default to 15 minutes and are capped at 2 hours. An expired lease is free.
`steal` is for a human, or for a holder that is clearly dead; it is recorded with
its reason. The store is a local prototype and will be replaced by a shared
service with the same commands.

## Keys

- `ticket:<ID>`: working a Linear ticket, e.g. `ticket:LLE-14778`.
- `main:<owner>/<repo>`: fixing red main on that repository, e.g.
  `main:lleverage-ai/lleverage`.
- `pr:<owner>/<repo>#<n>`: pushing to a PR you didn't open, e.g.
  `pr:lleverage-ai/lleverage#8104`.

Keys are normalised (ticket IDs upper case, everything else lower case).

## Holder label

The label must say who you are to a human and be unique to this session. Use the
exact same string for every command in the session.

- Sal and its workers: `sal <workspace>:<task>`, e.g. `sal dev:TASK-0182`.
- Claude Code: `claude-code $CLAUDE_CODE_SESSION_ID`, so the session-end hook
  below can release it.
- Pi: `pi $PI_SESSION_ID`.
- Codex: `codex <repo>@<branch>`.
- A subagent working on its parent's claim uses the label its brief gives it.

Put the context in the note: what you are doing and the ticket or PR, e.g.
`--note "LLE-14778 red-main fix, PR lleverage-ai/lleverage#8113"`. Update the
note with `renew --note` once the PR exists.

## Renew

Renew before anything long, with a TTL that covers it (up to 2h): `prwatch`
waits, test runs, builds. Renew again after each wait. If renew exits 3, someone
took the key after your lease lapsed: stop work on it and treat it as held.

## When it's held

1. Don't duplicate the work, and never fold it into your own PR.
2. Read the holder's note, age and last renewal. Check for visible progress since
   it was acquired: the PR in the note or `gh pr list --search <ID>`, new commits,
   ticket comments or state changes.
3. If it is moving, follow it: wait on its PR (prwatch), then rebase or carry
   on, or pick other work. Callers such as start-ticket stop `BLOCKED` naming the
   holder.
4. If the lease is live but nothing visible has happened for 30 minutes or more,
   ask the user once, with the holder and what you checked. Don't idle silently.
5. Never wait past `expires_at` without re-checking. Run `acquire` again then:
   if the lease expired, you get the key.

## Release

Release when the work is done (merged, or no change needed), when you hand it
off, and when you stop `BLOCKED` or are interrupted. At the end of a session run
`claim release-all --holder <label>`.

`claim list --stale` shows claims that expired without release or haven't been
renewed for over half their lease. Sweeps and heartbeats should report them.

## Optional Claude Code hooks

To release a Claude Code session's claims when it ends, add to
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "id=$(jq -r .session_id); ~/.agents/skills/claims/scripts/claim release-all --holder \"claude-code $id\" >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

The same command under `Stop` releases at the end of every turn. That frees
claims whenever the session waits for you, so the next turn must acquire again;
use it only if stale claims bother you more than that.
