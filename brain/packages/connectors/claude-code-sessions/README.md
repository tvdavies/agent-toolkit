# Claude Code sessions source connector

Standalone source connector for importing local Claude Code session JSONL files into Brain.

This is intentionally not part of the core CLI command surface. It follows the generic connector contract: write JSONL `record` objects to stdout, then let `brain sources sync` ingest/archive them.

## Register

```sh
brain sources add-command claude-code-local \
  --kind claude-code-session \
  --command 'bun /path/to/ai-assistant/packages/connectors/claude-code-sessions/src/index.ts'
```

Optional connector args can be embedded in the command:

```sh
brain sources add-command claude-code-local \
  --kind claude-code-session \
  --command 'bun /path/to/ai-assistant/packages/connectors/claude-code-sessions/src/index.ts --limit 200 --root ~/.claude/projects'
```

## Sync

```sh
brain sources sync claude-code-local --mode archive
```

Then run the memory cycle:

```sh
brain cycle --phase reflect --force
brain cycle --phase synthesize --force
```

## Output contract

Each imported session becomes a `brain.ingest.v1` record with a `brain.source-envelope.v1` envelope. The envelope includes:

- `sourceKind: "claude-code-session"`
- stable Claude Code `sourceId` / session id
- session title from the first user message
- timestamps
- cwd/repo/branch/projectName where available
- model/provider/thinking metadata
- source file path
