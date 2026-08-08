---
name: nuke-node-modules
description: Deletes node_modules directories quickly and safely without stalling the machine. Use whenever you need to remove or clean node_modules (e.g. before a fresh install, cleaning worktrees, fixing a corrupted install). NEVER run a plain `rm -rf node_modules` — use this skill's script instead.
metadata:
  author: tvd
  version: 1.0.0
---

# Nuke node_modules

Removing `node_modules` with plain `rm -rf` is slow (millions of metadata ops) and can saturate disk I/O for the whole machine — especially if an install runs in the same tree concurrently. This skill makes removal instant from the workflow's perspective.

## Usage

```bash
~/agent-skills/skills/nuke-node-modules/scripts/nuke.sh            # ./node_modules
~/agent-skills/skills/nuke-node-modules/scripts/nuke.sh path/to/node_modules other/node_modules
```

What it does:

1. `mv` the directory to a unique `.trash-node_modules-*` sibling — instant, so the path is free immediately.
2. Deletes the trash dir in a detached background process with `ionice -c3 nice -n 19`, so the actual delete only uses idle disk time and never stalls other work.

## Rules

- It is safe to start `pnpm install` / `bun install` immediately after the script returns — the rename has already freed the path.
- Never run a plain `rm -rf node_modules`, and never run an install while a foreground delete of the same tree is in progress.
- The background delete may run for a while; that's expected and harmless. Don't wait for it.
- If you see leftover `.trash-node_modules-*` or `.node_modules-partial` dirs, pass them to the script to clean up the same way.
