/**
 * `brain remember` — multi-turn capture from JSONL stdin.
 *
 * The hook entry-point. Claude Code / Pi extensions pipe a
 * conversation transcript in; each turn lands as one
 * `Memory.record` event. The full extraction stack runs (verbatim,
 * extractor, observer, consolidator) and edges get inferred — same
 * as `brain add` but multi-turn.
 *
 * Input format: one JSON object per line, with shape
 *   { "role": "user" | "assistant", "text": "...", "recordedAt"?: "..." }
 *
 * Empty lines are skipped silently. Malformed lines are reported
 * to stderr but don't fail the whole run — partial capture is
 * better than dropping a whole conversation.
 */

import type { Memory } from "@ai-assistant/contracts";
import { stats as queueStats } from "@ai-assistant/memory";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag, intFlag } from "../shared/args.js";
import { openBrain, resolveBrainHome, resolveBrainPath, resolveScope } from "../shared/brain.js";

const QUEUE_DEPTH_WARN = 100;

type TurnLine = {
  role: "user" | "assistant";
  text: string;
  recordedAt?: string;
};

export async function runRemember(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const date = flag(args, "date") ?? new Date().toISOString().slice(0, 10);
  const json = bool(args, "json");
  const sync = bool(args, "sync");
  const wait = bool(args, "wait");
  const timeoutMs = intFlag(args, "timeout", 30_000);

  const stdin = await readStdin();
  if (stdin.trim() === "") {
    process.stderr.write(
      "Usage: brain remember [--date YYYY-MM-DD] [--scope <name>]\n" +
        "  Reads JSONL turns from stdin, one per line:\n" +
        '    {"role":"user","text":"..."}\n' +
        '    {"role":"assistant","text":"..."}\n',
    );
    process.exit(2);
  }

  const turns = parseTurns(stdin, date);
  if (turns.length === 0) {
    process.stderr.write("brain remember: no valid turns in input.\n");
    process.exit(1);
  }

  const brain = await openBrain({ homeDir, rootDir, scope, asyncWrite: !sync });
  try {
    const before = brain.storage.size();
    for (const t of turns) {
      await recordTurn(brain.memory, t);
    }
    // Sync mode: drain the buffer through the full writer chain.
    // Async + --wait: block until the daemon catches up.
    // Async default: return immediately; verbatim already landed and
    // the rest is the daemon's problem.
    if (sync) {
      await brain.memory.flush?.();
    } else if (wait) {
      await brain.memory.flush?.({ timeoutMs });
    }
    const after = brain.storage.size();
    const added = after - before;
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            turns: turns.length,
            chunksBefore: before,
            chunksAfter: after,
            chunksAdded: added,
            recordedAt: date,
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
      `recorded ${turns.length} turn(s) · ${added} chunk(s) landed on disk · scope=${scope}${modeTag}\n`,
    );

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

function parseTurns(text: string, defaultDate: string): TurnLine[] {
  const out: TurnLine[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`brain remember: skipping unparseable line\n`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      process.stderr.write(`brain remember: skipping non-object line\n`);
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const role = obj.role;
    const text = obj.text;
    if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
      process.stderr.write(
        `brain remember: skipping line missing role/text (got role=${String(role)})\n`,
      );
      continue;
    }
    const recordedAt = typeof obj.recordedAt === "string" ? obj.recordedAt : defaultDate;
    out.push({ role, text, recordedAt });
  }
  return out;
}

async function recordTurn(memory: Memory, turn: TurnLine): Promise<void> {
  const base = { text: turn.text, recordedAt: turn.recordedAt ?? "" };
  if (turn.role === "user") {
    await memory.record({ kind: "user-turn", ...base });
  } else {
    await memory.record({ kind: "assistant-turn", ...base });
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      // No piped input — return empty so the caller prints usage.
      resolve("");
      return;
    }
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}
