#!/usr/bin/env bun
/**
 * Brain CLI entry point. Dispatches to subcommands.
 *
 * Convention: every subcommand reads `BRAIN_HOME` / `BRAIN_ROOT` /
 * `BRAIN_SCOPE` env vars by default, overridable via `--home` /
 * `--root` / `--scope`. JSON output via `--json` for cron / scripting.
 *
 * BRAIN_HOME (`~/brain/`) is machine-local: config + OAuth tokens +
 * daemon logs. BRAIN_ROOT (`~/brain/memories/`) is the wiki — the
 * git boundary lives there. ROOT defaults to `<home>/memories`.
 */

import { runAdd } from "./commands/add.js";
import { runAuth } from "./commands/auth/index.js";
import { runChat } from "./commands/chat.js";
import { runCorrect } from "./commands/correct.js";
import { runCycleCmd } from "./commands/cycle.js";
import { runDaemon } from "./commands/daemon.js";
import { runDoctor } from "./commands/doctor.js";
import { runExtensions } from "./commands/extensions.js";
import { runGet } from "./commands/get.js";
import { runIngest } from "./commands/ingest.js";
import { runInit } from "./commands/init.js";
import { runLs } from "./commands/ls.js";
import { runPin } from "./commands/pin.js";
import { runQuery } from "./commands/query.js";
import { runRebuildIndex } from "./commands/rebuild-index.js";
import { runReindex } from "./commands/reindex.js";
import { runReload } from "./commands/reload.js";
import { runRemember } from "./commands/remember.js";
import { runRestore } from "./commands/restore.js";
import { runRm } from "./commands/rm.js";
import { runSources } from "./commands/sources.js";
import { runWhy } from "./commands/why.js";
import { parseArgs } from "./shared/args.js";

const HELP = `brain — your personal memory CLI

Usage:
  brain <command> [options]

Commands:
  init                          Scaffold ~/brain/ (home) + ~/brain/memories/<scope>/ (wiki)
  auth <subcmd>                 Manage provider credentials (login | status | logout | refresh | test)
  add <text>                    Record a memory event (extraction runs)
  remember                      Capture a multi-turn conversation (JSONL stdin)
  ingest <file|- >              Ingest canonical BrainIngestRecord JSONL
  sources <subcmd>              Manage/sync source connectors
  query <text>                  Search the brain; render Chain-of-Note
  why <text>                    Show the score breakdown per retrieved hit
  get <slug | type/slug>        Print one memory file
  ls [type]                     List memories (optionally by type)
  rm <slug>                     Soft-delete a memory (--purge for hard delete)
  restore <slug>                Undo a soft-delete
  pin <slug>                    Promote authority to pinned (×3.0 boost)
  correct <slug>                Open in $EDITOR; promotes authority to manual
  rebuild-index                 Drop SQLite cache, rebuild from markdown
  cycle                         Run one maintenance cycle (--async to enqueue for daemon)
  daemon <subcmd>               Background queue-drain worker (run | start | stop | status | flush)
  extensions <subcmd>           List or validate extensions (list | validate)
  reload                        Ask running daemon to hot-reload at next safe boundary
  reindex                       Rebuild SQLite index from markdown files
  doctor                        Health check: counts, edges, last cycle
  chat                          Interactive REPL using config.yaml model + real Memory

Common flags:
  --home <dir>                  Brain home (env: BRAIN_HOME, default ~/brain) — config + auth + logs
  --root <dir>                  Brain wiki root (env: BRAIN_ROOT, default <home>/memories)
  --scope <name>                Scope name (env: BRAIN_SCOPE, default personal)
  --json                        Machine-readable output where supported

Daemon-specific (cycle):
  --phase <name>                Run a single phase: link-fix | reflect | synthesize | dedup | stale | patterns
  --async                       Queue cycle request for brain daemon, return immediately
  --watch                       Long-running; sleep --interval between cycles
  --interval <30s|5m|1h|1d>     How long to sleep in --watch mode (default 1h)
  --dry-run                     Compute, don't write
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.command === "" || args.command === "help" || argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }

  // Credentials are validated at openBrain time — config-aware,
  // per-purpose, with clear errors. No static startup check.

  switch (args.command) {
    case "init":
      await runInit(args);
      return;
    case "auth":
      await runAuth(args);
      return;
    case "add":
      await runAdd(args);
      return;
    case "remember":
      await runRemember(args);
      return;
    case "ingest":
      await runIngest(args);
      return;
    case "sources":
      await runSources(args);
      return;
    case "query":
      await runQuery(args);
      return;
    case "why":
      await runWhy(args);
      return;
    case "get":
      await runGet(args);
      return;
    case "ls":
      await runLs(args);
      return;
    case "rm":
      await runRm(args);
      return;
    case "restore":
      await runRestore(args);
      return;
    case "pin":
      await runPin(args);
      return;
    case "correct":
      await runCorrect(args);
      return;
    case "rebuild-index":
      await runRebuildIndex(args);
      return;
    case "cycle":
      await runCycleCmd(args);
      return;
    case "daemon":
      await runDaemon(args);
      return;
    case "extensions":
      await runExtensions(args);
      return;
    case "reload":
      await runReload(args);
      return;
    case "reindex":
      await runReindex(args);
      return;
    case "watch":
      process.stderr.write(
        "brain watch: removed — file-watching is now part of `brain daemon`. " +
          "Run `brain daemon start` (or `brain daemon run` for foreground).\n",
      );
      process.exit(2);
      return;
    case "doctor":
      await runDoctor(args);
      return;
    case "chat":
      await runChat(args);
      return;
    default:
      process.stderr.write(`Unknown command: ${args.command}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n${(err as Error).stack ?? ""}\n`);
  process.exit(1);
});
