import type { ParsedArgs } from "../shared/args.js";
import { bool, flag } from "../shared/args.js";
import { openBrain, resolveBrainHome, resolveBrainPath, resolveScope } from "../shared/brain.js";
import { createDefaultSourceStore, type SourceStore } from "../shared/source-store.js";
import {
  type IngestMode,
  parseJsonlRecords,
  renderRecordForMemory,
  type SourceConfig,
  sourcesConfigPath,
} from "../shared/sources.js";
import { ingestOne } from "./ingest.js";

export async function runSources(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const store = createDefaultSourceStore(homeDir);
  const [sub = "list", ...rest] = args.positional;
  switch (sub) {
    case "list":
      return list(homeDir, store, bool(args, "json"));
    case "add-command":
      return addCommand(store, rest, args);
    case "sync":
      return sync(homeDir, rootDir, scope, store, rest[0], args);
    case "status":
      return status(store, bool(args, "json"));
    case "stats":
      return stats(store, rest[0], bool(args, "json"));
    case "search":
      return search(store, rest.join(" "), args);
    case "jobs":
      return jobs(store, args);
    case "reindex":
      return reindexSources(store, args);
    case "enrich":
      return enrich(homeDir, rootDir, scope, store, args);
    case "log":
      return log(store, rest[0]);
    default:
      process.stderr.write(
        "Usage: brain sources list | add-command <id> --kind <kind> --command <cmd> [--schedule <cron>] | sync [id|--all] [--mode index|extract|archive] | search <query> | jobs | reindex | enrich [--limit N] | status | stats [id] | log [id]\n",
      );
      process.exit(2);
  }
}

function list(homeDir: string, store: SourceStore, json: boolean): void {
  const cfg = store.readSourcesConfig();
  if (json) {
    process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
    return;
  }
  if (cfg.sources.length === 0) {
    process.stdout.write(`No sources configured. Config: ${sourcesConfigPath(homeDir)}\n`);
    return;
  }
  for (const s of cfg.sources) {
    process.stdout.write(
      `${s.id}\t${s.type}\t${s.kind}\t${s.enabled === false ? "disabled" : "enabled"}\t${s.schedule ?? "manual"}\n`,
    );
  }
}

function addCommand(store: SourceStore, rest: string[], args: ParsedArgs): void {
  const id = rest[0];
  const kind = flag(args, "kind");
  const command = flag(args, "command");
  if (!id || !kind || !command) {
    process.stderr.write(
      "Usage: brain sources add-command <id> --kind <kind> --command <cmd> [--schedule <cron>]\n",
    );
    process.exit(2);
  }
  const cfg = store.readSourcesConfig();
  const source: SourceConfig = {
    id,
    type: "command",
    kind,
    command,
    enabled: true,
    mode: "pull",
    ...(flag(args, "schedule") !== undefined ? { schedule: flag(args, "schedule") } : {}),
  };
  const idx = cfg.sources.findIndex((s) => s.id === id);
  if (idx >= 0) cfg.sources[idx] = source;
  else cfg.sources.push(source);
  store.writeSourcesConfig(cfg);
  process.stdout.write(`source ${id} saved\n`);
}

async function sync(
  homeDir: string,
  rootDir: string,
  scope: string,
  store: SourceStore,
  id: string | undefined,
  args: ParsedArgs,
): Promise<void> {
  const cfg = store.readSourcesConfig();
  const selected =
    id === undefined || bool(args, "all")
      ? cfg.sources.filter((s) => s.enabled !== false)
      : cfg.sources.filter((s) => s.id === id && s.enabled !== false);
  if (selected.length === 0) {
    process.stderr.write(id ? `No enabled source ${id}\n` : "No enabled sources\n");
    process.exit(1);
  }
  const dryRun = bool(args, "dry-run");
  const json = bool(args, "json");
  const mode = ingestMode(flag(args, "mode"));
  const totals = [];
  const brain =
    !dryRun && mode === "extract"
      ? await openBrain({ homeDir, rootDir, scope, asyncWrite: false })
      : undefined;
  try {
    for (const source of selected) {
      if (source.type !== "command")
        throw new Error(`source ${source.id}: only command sources are implemented in v1`);
      const cursor = store.readCursor(source.id);
      const stdout = await store.runCommandConnector(source, cursor);
      const parsed = parseJsonlRecords(stdout);
      const counts = {
        source: source.id,
        records: parsed.records.length,
        created: 0,
        updated: 0,
        unchanged: 0,
        failed: 0,
      };
      if (!dryRun) {
        for (const record of parsed.records)
          counts[await ingestOne(store, brain?.memory, record, mode)]++;
        await brain?.memory.flush?.();
        if (parsed.checkpoint !== undefined) store.writeCursor(source.id, parsed.checkpoint);
      }
      totals.push(counts);
    }
  } finally {
    await brain?.close();
  }
  if (json) process.stdout.write(`${JSON.stringify({ sources: totals, dryRun, mode }, null, 2)}\n`);
  else
    for (const t of totals)
      process.stdout.write(
        `${t.source}: records=${t.records} created=${t.created} updated=${t.updated} unchanged=${t.unchanged} failed=${t.failed}${dryRun ? " (dry-run)" : ""}\n`,
      );
}

function ingestMode(raw: string | undefined): IngestMode {
  if (raw === "archive" || raw === "index" || raw === "extract") return raw;
  return "extract";
}

function status(store: SourceStore, json: boolean): void {
  const cfg = store.readSourcesConfig();
  const ledger = store.readLedger();
  const jobs = store.listJobs(500);
  const rows = cfg.sources.map((s) => {
    const entries = Object.values(ledger).filter((e) => e.sourceInstanceId === s.id);
    const keys = new Set(entries.map((e) => e.key));
    const sourceJobs = jobs.filter((j) => keys.has(j.sourceDocumentKey));
    return {
      id: s.id,
      type: s.type,
      kind: s.kind,
      enabled: s.enabled !== false,
      documents: entries.length,
      lastSeenAt: entries
        .map((e) => e.lastSeenAt)
        .sort()
        .at(-1),
      jobs: {
        pending: sourceJobs.filter((j) => j.status === "pending").length,
        running: sourceJobs.filter((j) => j.status === "running").length,
        failed: sourceJobs.filter((j) => j.status === "failed").length,
      },
    };
  });
  if (json) process.stdout.write(`${JSON.stringify({ sources: rows }, null, 2)}\n`);
  else
    for (const r of rows)
      process.stdout.write(
        `${r.id}\t${r.kind}\tdocs=${r.documents}\tjobs=pending:${r.jobs.pending},running:${r.jobs.running},failed:${r.jobs.failed}\tlast=${r.lastSeenAt ?? "-"}\n`,
      );
}

function stats(store: SourceStore, id: string | undefined, json: boolean): void {
  const entries = Object.values(store.readLedger()).filter(
    (e) => e.status === "active" && (id === undefined || e.sourceInstanceId === id),
  );
  const bySource = new Map<
    string,
    {
      source: string;
      records: number;
      chars: number;
      estimatedTokens: number;
      candidates: number;
      huge: number;
      maxChars: number;
      examples: string[];
    }
  >();
  const signals = [
    /\bremember\b/i,
    /\bpreference\b/i,
    /\bwe decided\b/i,
    /\bfrom now on\b/i,
    /\balways\b/i,
    /\bdon't\b/i,
    /\barchitecture\b/i,
    /\bbacklog\b/i,
    /\bLLE-\d+\b/i,
    /\bBRAIN-\d+\b/i,
    /\bPR\b/i,
  ];
  for (const entry of entries) {
    const record = store.readDocumentRecord(entry.key);
    if (record === undefined) continue;
    const chars = record.body.length;
    const candidate = signals.some((re) => re.test(record.body)) || chars > 20_000;
    const row = bySource.get(entry.sourceInstanceId) ?? {
      source: entry.sourceInstanceId,
      records: 0,
      chars: 0,
      estimatedTokens: 0,
      candidates: 0,
      huge: 0,
      maxChars: 0,
      examples: [],
    };
    row.records++;
    row.chars += chars;
    row.estimatedTokens += Math.ceil(chars / 4);
    if (candidate) row.candidates++;
    if (chars > 50_000) row.huge++;
    row.maxChars = Math.max(row.maxChars, chars);
    if (candidate && row.examples.length < 5) row.examples.push(record.title ?? entry.externalId);
    bySource.set(entry.sourceInstanceId, row);
  }
  const sources = [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source));
  const total = sources.reduce(
    (acc, r) => ({
      records: acc.records + r.records,
      chars: acc.chars + r.chars,
      estimatedTokens: acc.estimatedTokens + r.estimatedTokens,
      candidates: acc.candidates + r.candidates,
      huge: acc.huge + r.huge,
    }),
    { records: 0, chars: 0, estimatedTokens: 0, candidates: 0, huge: 0 },
  );
  const estimate = {
    reflectCalls: Math.ceil(total.records / 30),
    synthesizeCalls: Math.ceil(total.candidates / 15),
    totalCallsLow: Math.ceil(total.records / 30) + Math.ceil(total.candidates / 15),
    totalCallsHigh: Math.ceil(total.records / 20) + Math.ceil(total.candidates / 8),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify({ total, estimate, sources }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `records=${total.records} chars=${total.chars} estTokens=${total.estimatedTokens} candidates=${total.candidates} huge=${total.huge}\n`,
  );
  process.stdout.write(
    `estimated LLM calls: ${estimate.totalCallsLow}-${estimate.totalCallsHigh} (reflect ${estimate.reflectCalls}, synthesize ${estimate.synthesizeCalls}+)\n`,
  );
  for (const r of sources)
    process.stdout.write(
      `${r.source}\trecords=${r.records}\testTokens=${r.estimatedTokens}\tcandidates=${r.candidates}\thuge=${r.huge}\tmaxChars=${r.maxChars}\n`,
    );
}

function search(store: SourceStore, query: string, args: ParsedArgs): void {
  if (query.trim() === "") {
    process.stderr.write("Usage: brain sources search <query>\n");
    process.exit(2);
  }
  const limitRaw = flag(args, "limit");
  const limit = limitRaw === undefined ? 10 : Number.parseInt(limitRaw, 10) || 10;
  const hits = store.search(query, limit);
  if (bool(args, "json")) {
    process.stdout.write(
      `${JSON.stringify({ items: hits.map((hit) => ({ ...hit, kind: "source-document", distilled: false })) }, null, 2)}\n`,
    );
    return;
  }
  for (const hit of hits) {
    const title = hit.title ?? hit.externalId;
    const body = hit.body.replace(/\s+/g, " ").slice(0, 220);
    process.stdout.write(
      `[source-document, not yet distilled] ${hit.sourceInstanceId} ${title}\n${body}\n${hit.uri ?? ""}\n\n`,
    );
  }
}

function jobs(store: SourceStore, args: ParsedArgs): void {
  const limit = Number.parseInt(flag(args, "limit") ?? "50", 10) || 50;
  const rows = store.listJobs(limit);
  if (bool(args, "json")) {
    process.stdout.write(`${JSON.stringify({ jobs: rows }, null, 2)}\n`);
    return;
  }
  for (const job of rows) {
    process.stdout.write(
      `${job.status}\t${job.attempts}\t${job.sourceDocumentKey}\t${job.type}\t${job.id}\n`,
    );
  }
}

function reindexSources(store: SourceStore, args: ParsedArgs): void {
  const result = store.rebuildFromArchive();
  if (bool(args, "json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`sources reindex: ${result.packages} package(s)\n`);
}

async function enrich(
  homeDir: string,
  rootDir: string,
  scope: string,
  store: SourceStore,
  args: ParsedArgs,
): Promise<void> {
  const limit = Number.parseInt(flag(args, "limit") ?? "10", 10) || 10;
  const json = bool(args, "json");
  const claimed = store.claimJobs(limit);
  const counts = { claimed: claimed.length, completed: 0, failed: 0 };
  const brain = await openBrain({ homeDir, rootDir, scope, asyncWrite: false });
  try {
    for (const job of claimed) {
      try {
        const record = store.readDocumentRecord(job.sourceDocumentKey);
        if (record === undefined)
          throw new Error(`source document not found: ${job.sourceDocumentKey}`);
        await brain.memory.record({
          kind: "ingested-item",
          source: { kind: "memory", id: `${record.source.instanceId}:${record.source.externalId}` },
          content: renderRecordForMemory(record),
          recordedAt:
            record.observedAt ?? record.createdAt ?? record.updatedAt ?? record.ingestedAt,
        });
        await brain.memory.flush?.();
        store.completeJob(job.id);
        counts.completed++;
      } catch (err) {
        store.failJob(job.id, err instanceof Error ? err.message : String(err));
        counts.failed++;
      }
    }
  } finally {
    await brain.close();
  }
  if (json) process.stdout.write(`${JSON.stringify({ ...counts }, null, 2)}\n`);
  else
    process.stdout.write(
      `enrich: claimed=${counts.claimed} completed=${counts.completed} failed=${counts.failed}\n`,
    );
}

function log(store: SourceStore, id: string | undefined): void {
  const entries = Object.values(store.readLedger()).filter(
    (e) => id === undefined || e.sourceInstanceId === id,
  );
  for (const e of entries.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 50)) {
    process.stdout.write(
      `${e.lastSeenAt}\t${e.sourceInstanceId}\t${e.externalId}\t${e.status}\t${e.title ?? ""}\n`,
    );
  }
}
