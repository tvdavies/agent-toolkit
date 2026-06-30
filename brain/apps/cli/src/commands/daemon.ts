/**
 * `brain daemon` — manage the background queue-drain worker.
 *
 * Subcommands:
 *   brain daemon run     # foreground worker loop (used by start, systemd)
 *   brain daemon start   # fork, write PID, return immediately
 *   brain daemon stop    # read PID file, SIGTERM
 *   brain daemon status  # running? queue depth? last error?
 *   brain daemon flush   # drainUntilEmpty in-process, then exit
 *
 * The daemon opens the user's brain in **async write mode** and ticks
 * a queue-drain loop every `--interval` ms (default 500). Each tick
 * claims a small batch from `<homeDir>/queue/pending/` and runs the
 * slow writer chain (extractor + observer + consolidator + graph) on
 * each item via `Memory.processQueuedItem`.
 *
 * One daemon per BRAIN_HOME. PID lives at `<homeDir>/daemon.pid`,
 * combined stdout/stderr at `<homeDir>/daemon.log`. The daemon traps
 * SIGTERM/SIGINT and finishes its current batch before exiting so
 * partial work doesn't get re-claimed unnecessarily on restart.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { watch } from "node:fs/promises";
import { resolve } from "node:path";
import { extensionRoots } from "@ai-assistant/brain-core";
import { drainOnce, drainUntilEmpty, recoverInFlight, stats } from "@ai-assistant/memory";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag, intFlag } from "../shared/args.js";
import {
  type Brain,
  configPath,
  openBrain,
  resolveBrainHome,
  resolveBrainPath,
  resolveScope,
} from "../shared/brain.js";
import { claimCycleRequest } from "../shared/cycle-queue.js";
import { startFileWatcher } from "../shared/file-watcher.js";
import { runCycleNow } from "./cycle.js";

const HELP = `brain daemon — background worker

Two coroutines run in one process by default:
  - Queue-drain: claims pending events, runs the slow writer chain.
  - File watcher: reconciles markdown edits back into the SQLite index.

Usage:
  brain daemon run [--interval 500] [--batch 16] [--debounce 150]
                   [--no-watch] [--no-embed]      Foreground loop
  brain daemon start                                Fork to background
  brain daemon stop                                 SIGTERM the running daemon
  brain daemon status [--json]                      Running? Queue depth?
  brain daemon flush [--timeout 30000]              Process pending items, exit

The foreground \`run\` mode is what \`start\` invokes under the hood
and what systemd should target. \`flush\` is a one-shot synchronous
drain useful for tests and the \`brain add --wait\` short-cut.
\`--no-watch\` disables the filesystem watcher (queue-drain only) for
read-only setups. \`--no-embed\` skips re-embedding on file edits.
`;

const PID_FILENAME = "daemon.pid";
const LOG_FILENAME = "daemon.log";

function ensureHomeDir(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  chmodSync(homeDir, 0o700);
}

export async function runDaemon(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0] ?? "";
  const subArgs: ParsedArgs = { ...args, positional: args.positional.slice(1) };

  switch (sub) {
    case "run":
      await runForeground(subArgs);
      return;
    case "start":
      await runStart(subArgs);
      return;
    case "stop":
      await runStop(subArgs);
      return;
    case "status":
      await runStatus(subArgs);
      return;
    case "flush":
      await runFlush(subArgs);
      return;
    case "":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`Unknown daemon subcommand: ${sub}\n\n${HELP}`);
      process.exit(2);
  }
}

// ─── run: foreground worker loop ────────────────────────────────

async function runForeground(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const intervalMs = intFlag(args, "interval", 500);
  const batchSize = intFlag(args, "batch", 16);
  const debounceMs = intFlag(args, "debounce", 150);
  const noWatch = bool(args, "no-watch");
  const noEmbed = bool(args, "no-embed");

  // PID file: refuse to start if another daemon is alive on this home.
  ensureHomeDir(homeDir);
  ensureHomeDir(rootDir);
  mkdirSync(resolve(rootDir, scope), { recursive: true, mode: 0o700 });
  chmodSync(resolve(rootDir, scope), 0o700);
  const pidPath = resolve(homeDir, PID_FILENAME);
  if (existsSync(pidPath)) {
    const existing = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (Number.isFinite(existing) && existing > 0 && isProcessAlive(existing)) {
      process.stderr.write(
        `brain daemon: already running on ${homeDir} (pid ${existing}). Stop it first.\n`,
      );
      process.exit(2);
    }
    // Stale pid — remove and proceed.
    try {
      unlinkSync(pidPath);
    } catch {
      // best-effort
    }
  }
  writeFileSync(pidPath, String(process.pid), "utf8");

  // Open the brain in async write mode. The daemon is the only
  // process that runs the slow writer chain, so we don't want
  // record() in this process to also enqueue (it'd recurse).
  // brain.memory.processQueuedItem is what we call per claimed item.
  let brain = await openBrain({ homeDir, rootDir, scope, asyncWrite: true });

  // Recovery sweep: any items left in in-flight/ from a previous
  // crash get moved back to pending/ before the loop starts.
  const recovered = await recoverInFlight({ homeDir });
  if (recovered > 0) {
    process.stdout.write(`brain daemon: recovered ${recovered} in-flight item(s)\n`);
  }

  let stopping = false;
  let reloadRequested = false;
  const requestReload = (reason: string) => {
    reloadRequested = true;
    process.stdout.write(`brain daemon: reload requested (${reason})\n`);
  };
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`brain daemon: ${signal} received, draining current batch...\n`);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGHUP", () => requestReload("SIGHUP"));

  process.stdout.write(
    `brain daemon: running on ${homeDir} (scope=${scope}, interval=${intervalMs}ms, batch=${batchSize}${noWatch ? ", watch=off" : `, debounce=${debounceMs}ms`})\n`,
  );

  // File watcher coroutine — enabled by default, off with --no-watch.
  // Runs in parallel with the queue-drain loop. Stops on the same
  // SIGTERM/SIGINT that stops the loop.
  let watcher = noWatch
    ? null
    : startFileWatcher({
        scopeDir: resolve(rootDir, scope),
        storage: brain.storage,
        markdownStore: brain.markdownStore,
        debounceMs,
        embedOnReindex: !noEmbed,
        // Pass the configured embedder so the watcher's reindex matches
        // the SQLite vec table dim. Default fallback (createGatewayEmbedder)
        // is 3072d and crashes against a 768d local-embedder index.
        embedder: brain.embedder,
        usage: brain.usage,
        log: (line) => process.stdout.write(`${line}\n`),
      });

  const reloadWatcher = startReloadWatcher({ homeDir, rootDir, log: requestReload });

  const reopenBrain = async (): Promise<void> => {
    reloadRequested = false;
    process.stdout.write("brain daemon: reloading brain runtime...\n");
    let nextBrain: Brain | undefined;
    try {
      nextBrain = await openBrain({ homeDir, rootDir, scope, asyncWrite: true });
    } catch (err) {
      await nextBrain?.close();
      process.stderr.write(
        `brain daemon: reload failed; keeping existing runtime: ${(err as Error).message}\n`,
      );
      return;
    }
    if (watcher !== null) await watcher.stop();
    await brain.close();
    brain = nextBrain;
    watcher = noWatch
      ? null
      : startFileWatcher({
          scopeDir: resolve(rootDir, scope),
          storage: brain.storage,
          markdownStore: brain.markdownStore,
          debounceMs,
          embedOnReindex: !noEmbed,
          embedder: brain.embedder,
          usage: brain.usage,
          log: (line) => process.stdout.write(`${line}\n`),
        });
    process.stdout.write("brain daemon: reload complete\n");
  };

  // Tight loop. drainOnce returns immediately when the queue is empty,
  // so we sleep `intervalMs` between ticks to avoid pegging the CPU.
  try {
    while (!stopping) {
      const memory = brain.memory as unknown as {
        processQueuedItem: (item: { event: unknown }) => Promise<void>;
      };
      const result = await drainOnce({
        memory: memory as Parameters<typeof drainOnce>[0]["memory"],
        homeDir,
        scope,
        maxItems: batchSize,
        log: (msg) => process.stdout.write(`${msg}\n`),
      });
      if (stopping) break;
      const cycleClaim = await claimCycleRequest(homeDir);
      if (cycleClaim !== null) {
        try {
          const report = await runCycleNow({
            homeDir,
            rootDir,
            scope: cycleClaim.request.scope,
            dryRun: cycleClaim.request.dryRun,
            ...(cycleClaim.request.phase !== undefined
              ? {
                  phaseFilter: cycleClaim.request.phase as Parameters<
                    typeof runCycleNow
                  >[0]["phaseFilter"],
                }
              : {}),
          });
          process.stdout.write(
            `cycle ${report.runId}: processed queued request ${cycleClaim.request.id}\n`,
          );
          await cycleClaim.ack();
        } catch (err) {
          process.stderr.write(
            `cycle request ${cycleClaim.request.id} failed: ${(err as Error).message}\n`,
          );
          await cycleClaim.fail();
        }
      }
      if (reloadRequested && !stopping) await reopenBrain();
      if (result.processed === 0 && result.errored === 0 && cycleClaim === null) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      // After a non-empty batch, loop immediately so we drain bursts
      // without an artificial 500ms wait between them.
    }
  } finally {
    await reloadWatcher.stop();
    if (watcher !== null) await watcher.stop();
    await brain.close();
    try {
      unlinkSync(pidPath);
    } catch {
      // best-effort
    }
    process.stdout.write("brain daemon: stopped\n");
  }
}

// ─── start: fork to background ──────────────────────────────────

async function runStart(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  ensureHomeDir(homeDir);
  const pidPath = resolve(homeDir, PID_FILENAME);
  const logPath = resolve(homeDir, LOG_FILENAME);

  if (existsSync(pidPath)) {
    const existing = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (Number.isFinite(existing) && existing > 0 && isProcessAlive(existing)) {
      process.stdout.write(`brain daemon: already running (pid ${existing})\n`);
      return;
    }
    try {
      unlinkSync(pidPath);
    } catch {
      // best-effort
    }
  }

  // Re-spawn ourselves as `brain daemon run`, detached, with stdout +
  // stderr redirected to <homeDir>/daemon.log. The forked process
  // writes its own PID file once it boots.
  const logFile = Bun.file(logPath);
  await Bun.write(logFile, "");
  chmodSync(logPath, 0o600);
  const child = Bun.spawn({
    cmd: [process.execPath, process.argv[1] ?? "", "daemon", "run", ...passThrough(args)],
    stdout: logFile,
    stderr: logFile,
    stdin: "ignore",
    detached: true,
  });
  // Detach: don't await child and don't let the Subprocess handle keep
  // `brain daemon start` alive after it has handed off to the child.
  child.unref();
  // Give the child a moment to boot and write its pid file. If it
  // fails before that, pid file won't appear and the user can check
  // the log.
  await new Promise((r) => setTimeout(r, 250));
  if (existsSync(pidPath)) {
    const pid = readFileSync(pidPath, "utf8").trim();
    process.stdout.write(`brain daemon: started (pid ${pid}), logs at ${logPath}\n`);
  } else {
    process.stderr.write(
      `brain daemon: child did not write pid file within 250ms; check ${logPath}\n`,
    );
    process.exit(1);
  }
}

/**
 * Return only the flags that should be inherited by the forked child
 * process. Subcommand and positionals are dropped (the child runs
 * `daemon run` not `daemon start`); pass-through flags are the ones
 * that affect openBrain's behaviour.
 */
function passThrough(args: ParsedArgs): string[] {
  const out: string[] = [];
  const stringFlags = ["home", "root", "scope", "interval", "batch", "debounce"];
  const boolFlags = ["no-watch", "no-embed"];
  for (const key of stringFlags) {
    const v = args.flags[key];
    if (typeof v === "string") {
      out.push(`--${key}`, v);
    }
  }
  for (const key of boolFlags) {
    if (args.flags[key] === true) out.push(`--${key}`);
  }
  return out;
}

// ─── stop: SIGTERM the running daemon ───────────────────────────

async function runStop(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const pidPath = resolve(homeDir, PID_FILENAME);
  if (!existsSync(pidPath)) {
    process.stdout.write("brain daemon: not running\n");
    return;
  }
  const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    process.stderr.write(`brain daemon: pid file at ${pidPath} is malformed\n`);
    try {
      unlinkSync(pidPath);
    } catch {
      // best-effort
    }
    process.exit(1);
  }
  if (!isProcessAlive(pid)) {
    process.stdout.write(`brain daemon: pid ${pid} is stale, removing pid file\n`);
    try {
      unlinkSync(pidPath);
    } catch {
      // best-effort
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    process.stdout.write(`brain daemon: sent SIGTERM to pid ${pid}\n`);
  } catch (err) {
    process.stderr.write(`brain daemon: failed to signal pid ${pid}: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// ─── status: print state + queue depth ──────────────────────────

async function runStatus(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const json = bool(args, "json");
  const pidPath = resolve(homeDir, PID_FILENAME);

  let pid: number | null = null;
  let alive = false;
  if (existsSync(pidPath)) {
    const raw = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (Number.isFinite(raw) && raw > 0) {
      pid = raw;
      alive = isProcessAlive(raw);
    }
  }

  const q = await stats({ homeDir });

  if (json) {
    process.stdout.write(`${JSON.stringify({ homeDir, pid, alive, queue: q }, null, 2)}\n`);
    return;
  }

  const state = pid === null ? "not running" : alive ? `running (pid ${pid})` : `stale pid ${pid}`;
  process.stdout.write(`brain daemon: ${state}\n`);
  process.stdout.write(`queue: pending=${q.pending} in-flight=${q.inFlight} failed=${q.failed}\n`);
}

// ─── flush: drainUntilEmpty in-process ──────────────────────────

async function runFlush(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const timeoutMs = intFlag(args, "timeout", 30_000);

  const brain = await openBrain({ homeDir, rootDir, scope, asyncWrite: true });
  const memory = brain.memory as unknown as {
    processQueuedItem: (item: { event: unknown }) => Promise<void>;
  };
  const deadline = Date.now() + timeoutMs;
  try {
    let processed = 0;
    let errored = 0;
    while (Date.now() < deadline) {
      const r = await drainUntilEmpty({
        memory: memory as Parameters<typeof drainUntilEmpty>[0]["memory"],
        homeDir,
        scope,
      });
      processed += r.processed;
      errored += r.errored;
      // drainUntilEmpty returns when the queue is empty for one tick.
      // Break here unless something is still arriving (race against a
      // concurrent producer).
      const s = await stats({ homeDir });
      if (s.pending === 0 && s.inFlight === 0) {
        process.stdout.write(
          `brain daemon flush: drained processed=${processed} errored=${errored}\n`,
        );
        return;
      }
      // Brief sleep to let a producer mid-write finish.
      await new Promise((r) => setTimeout(r, 50));
    }
    process.stderr.write(
      `brain daemon flush: timed out after ${timeoutMs}ms (processed=${processed} errored=${errored})\n`,
    );
    process.exit(1);
  } finally {
    await brain.close();
  }
}

// ─── reload watcher ─────────────────────────────────────────────

type ReloadWatcher = { stop(): Promise<void> };

function startReloadWatcher(opts: {
  homeDir: string;
  rootDir: string;
  log: (reason: string) => void;
}): ReloadWatcher {
  const ac = new AbortController();
  const roots = [
    configPath(opts.homeDir),
    ...extensionRoots({ homeDir: opts.homeDir, rootDir: opts.rootDir }),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    void watchReloadPath(root, ac.signal, opts.log);
  }
  return {
    async stop() {
      ac.abort();
    },
  };
}

async function watchReloadPath(
  path: string,
  signal: AbortSignal,
  log: (reason: string) => void,
): Promise<void> {
  try {
    for await (const event of watch(path, { recursive: true, signal })) {
      const name = event.filename?.toString() ?? path;
      if (name.includes(".swp") || name.endsWith("~")) continue;
      if (
        name.endsWith(".ts") ||
        name.endsWith(".yaml") ||
        name.endsWith(".yml") ||
        path.endsWith("config.yaml")
      ) {
        log(`${path}/${name}`);
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    const name = (err as Error).name ?? "";
    if (code === "ABORT_ERR" || name === "AbortError") return;
    process.stderr.write(`reload watcher error for ${path}: ${(err as Error).message}\n`);
  }
}

// ─── helpers ────────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 is a no-op probe: throws ESRCH if the pid doesn't exist,
    // EPERM if we lack permission (treat as alive).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
