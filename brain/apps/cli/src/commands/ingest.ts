import { readFile } from "node:fs/promises";
import type { Memory } from "@ai-assistant/contracts";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag } from "../shared/args.js";
import { openBrain, resolveBrainHome, resolveBrainPath, resolveScope } from "../shared/brain.js";
import { createDefaultSourceStore, type SourceStore } from "../shared/source-store.js";
import {
  contentForRecord,
  type IngestMode,
  type IngestRecord,
  parseJsonlRecords,
  redactIngestRecord,
  renderRecordForMemory,
  sha256,
  sourceKey,
} from "../shared/sources.js";

export async function runIngest(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const json = bool(args, "json");
  const dryRun = bool(args, "dry-run");
  const mode = ingestMode(flag(args, "mode"));
  const sync = bool(args, "sync") || dryRun || mode !== "extract";
  const inputPath = args.positional[0];
  const input =
    inputPath === undefined || inputPath === "-"
      ? await readStdin()
      : await readFile(inputPath, "utf8");
  const parsed = parseJsonlRecords(input);
  const store = createDefaultSourceStore(homeDir);

  const counts = {
    records: parsed.records.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
  };
  if (!dryRun) {
    if (mode === "extract") {
      const brain = await openBrain({ homeDir, rootDir, scope, asyncWrite: !sync });
      try {
        for (const record of parsed.records) {
          const decision = await ingestOne(store, brain.memory, record, mode);
          counts[decision]++;
        }
        if (sync) await brain.memory.flush?.();
      } finally {
        await brain.close();
      }
    } else {
      for (const record of parsed.records) {
        const decision = await ingestOne(store, undefined, record, mode);
        counts[decision]++;
      }
    }
  } else {
    for (const record of parsed.records) {
      const decision = previewDecision(store, record);
      counts[decision]++;
    }
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ...counts, dryRun, mode, logs: parsed.logs }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(
    `ingest: ${counts.records} record(s), created=${counts.created}, updated=${counts.updated}, unchanged=${counts.unchanged}, failed=${counts.failed}${dryRun ? " (dry-run)" : ""}\n`,
  );
}

export async function ingestOne(
  store: SourceStore,
  memory: Memory | undefined,
  record: IngestRecord,
  mode: IngestMode = "extract",
): Promise<"created" | "updated" | "unchanged" | "failed"> {
  try {
    const safeRecord = redactIngestRecord(record);
    const { decision, entry } = store.decideAndUpdate(safeRecord);
    if (decision === "unchanged") return "unchanged";
    if (mode !== "extract") {
      store.enqueueEnrichment(entry);
      return decision;
    }
    if (memory === undefined) throw new Error("extract mode requires memory");
    await memory.record({
      kind: "ingested-item",
      source: { kind: "memory", id: `${safeRecord.source.instanceId}:${safeRecord.source.externalId}` },
      content: renderRecordForMemory(safeRecord),
      recordedAt: safeRecord.observedAt ?? safeRecord.createdAt ?? safeRecord.updatedAt ?? safeRecord.ingestedAt,
    });
    return decision;
  } catch {
    return "failed";
  }
}

function ingestMode(raw: string | undefined): IngestMode {
  if (raw === "archive" || raw === "index" || raw === "extract") return raw;
  return "extract";
}

function previewDecision(
  store: SourceStore,
  record: IngestRecord,
): "created" | "updated" | "unchanged" {
  const safeRecord = redactIngestRecord(record);
  const existing = store.readLedger()[sourceKey(safeRecord)];
  if (existing === undefined) return "created";
  return existing.contentHash === sha256(contentForRecord(safeRecord)) ? "unchanged" : "updated";
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
    if (process.stdin.isTTY) resolve("");
  });
}
