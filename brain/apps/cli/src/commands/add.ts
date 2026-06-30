/**
 * `brain add <text>` — record a memory event.
 *
 * Default (async) path:
 *   1. Open the brain in async write mode.
 *   2. `record()` runs the verbatim writer synchronously (BM25 sees
 *      the turn straight away) and enqueues the event.
 *   3. The background `brain daemon` runs the slow writer chain
 *      (extractor + observer + consolidator) on the queued event.
 *   4. Return immediately. ~10-50ms.
 *
 * Flags:
 *   --wait              Block until the daemon has drained this event
 *                       (calls Memory.flush; honours --timeout).
 *   --sync              Run the full writer chain inline (legacy
 *                       behaviour, used by tests / eval / when the
 *                       daemon is intentionally off).
 *   --timeout <ms>      How long --wait waits before giving up. Default 30000.
 *
 * Multi-line input via stdin: `brain add - < notes.txt` or pipe.
 * Single-line: `brain add "User attended Sarah's wedding."`
 */

import { readFileSync } from "node:fs";
import { stats as queueStats } from "@ai-assistant/memory";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag, intFlag } from "../shared/args.js";
import { openBrain, resolveBrainHome, resolveBrainPath, resolveScope } from "../shared/brain.js";

const QUEUE_DEPTH_WARN = 100;

export async function runAdd(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const role = flag(args, "as", "user");
  const recordedAt = flag(args, "date") ?? new Date().toISOString().slice(0, 10);
  const json = bool(args, "json");
  const sync = bool(args, "sync");
  const wait = bool(args, "wait");
  const timeoutMs = intFlag(args, "timeout", 30_000);

  const text = await readInput(args);
  if (text.trim() === "") {
    process.stderr.write("Usage: brain add <text> | brain add - < file\n");
    process.exit(2);
  }

  // --sync forces the legacy synchronous writer chain. Otherwise default
  // to async: verbatim lands now, daemon catches up the rest.
  const brain = await openBrain({ homeDir, rootDir, scope, asyncWrite: !sync });
  try {
    const before = countFiles(brain);
    if (role === "assistant") {
      await brain.memory.record({ kind: "assistant-turn", text, recordedAt });
    } else {
      await brain.memory.record({ kind: "user-turn", text, recordedAt });
    }

    // In sync mode, retrieve() implicitly flushes; in async mode we
    // either skip flush (return immediately) or wait for the daemon
    // depending on --wait.
    if (sync) {
      await brain.memory.flush?.();
    } else if (wait) {
      await brain.memory.flush?.({ timeoutMs });
    }
    const after = countFiles(brain);

    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            recorded: text.length,
            recordedAt,
            chunksBefore: before,
            chunksAfter: after,
            chunksAdded: after - before,
            mode: sync ? "sync" : wait ? "async-wait" : "async",
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    const modeTag = sync ? " (sync)" : wait ? " (waited)" : "";
    process.stdout.write(
      `recorded ${text.length} chars · ${after - before} chunk(s) landed on disk · scope=${scope}${modeTag}\n`,
    );

    // Queue-depth warning. Cheap stat; only prints when async path is
    // active so it doesn't clutter --sync runs.
    if (!sync) {
      const q = await queueStats({ homeDir });
      if (q.pending >= QUEUE_DEPTH_WARN) {
        process.stderr.write(
          `note: ${q.pending} item(s) waiting in queue. Is \`brain daemon\` running? ` +
            `Check \`brain daemon status\`.\n`,
        );
      }
    }
  } finally {
    await brain.close();
  }
}

async function readInput(args: ParsedArgs): Promise<string> {
  const positional = args.positional.join(" ");
  if (positional === "-") {
    return readStdin();
  }
  if (positional.length > 0) return positional;
  // No positional args + tty stdin → expect prose; non-tty → read.
  if (!process.stdin.isTTY) return readStdin();
  return "";
}

function readStdin(): Promise<string> {
  return new Promise((res, rej) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
    });
    process.stdin.on("end", () => res(buf));
    process.stdin.on("error", rej);
  });
}

function countFiles(brain: { storage: { size(): number } }): number {
  return brain.storage.size();
}

void readFileSync; // reserved for `--file` flag.
