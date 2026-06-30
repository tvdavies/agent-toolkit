import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  INGEST_SCHEMA,
  type IngestRecord,
  IngestRecord as IngestRecordSchema,
  SOURCE_ENVELOPE_SCHEMA,
  type SourceEnvelope,
  SourceEnvelope as SourceEnvelopeSchema,
} from "@ai-assistant/contracts";
import { type Frontmatter, parse as parseFrontmatter, redact, redactDeep, serialise } from "@ai-assistant/memory";

export {
  INGEST_SCHEMA,
  IngestRecordSchema,
  SOURCE_ENVELOPE_SCHEMA,
  SourceEnvelopeSchema,
  type IngestRecord,
  type SourceEnvelope,
};

export type SourceLedgerEntry = {
  key: string;
  sourceInstanceId: string;
  sourceKind: string;
  externalId: string;
  uri?: string;
  title?: string;
  rawHash: string;
  contentHash: string;
  firstIngestedAt: string;
  lastIngestedAt: string;
  lastSeenAt: string;
  updatedAt?: string;
  status: "active" | "failed" | "deleted";
  memoryIds?: string[];
  error?: string;
};

export type IngestDecision = "created" | "updated" | "unchanged" | "failed";
export type IngestMode = "archive" | "index" | "extract";

export type SourceJobStatus = "pending" | "running" | "done" | "failed";

const SOURCE_JOB_MAX_ATTEMPTS = 3;
const SOURCE_JOB_BACKOFF_BASE_MS = 60_000;
const SOURCE_JOB_BACKOFF_MAX_MS = 60 * 60_000;

export type SourceEnrichmentJob = {
  id: string;
  type: "extract-source-doc";
  sourceDocumentKey: string;
  contentHash: string;
  extractionHash: string;
  status: SourceJobStatus;
  priority: number;
  attempts: number;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
};

export type SourceConfig = {
  id: string;
  type: "command" | "inbox" | "files";
  kind: string;
  enabled?: boolean;
  command?: string;
  schedule?: string;
  mode?: "pull" | "push" | "manual";
  config?: Record<string, unknown>;
};

export type SourcesConfig = { sources: SourceConfig[] };

export function sourceKey(record: IngestRecord): string {
  return `${record.source.instanceId}:${record.source.externalId}`;
}

export function sourceEnvelopeForRecord(record: IngestRecord): SourceEnvelope {
  const contentHash = sha256(contentForRecord(record));
  return SourceEnvelopeSchema.parse({
    schema: SOURCE_ENVELOPE_SCHEMA,
    sourceKind: record.envelope?.sourceKind ?? record.source.kind,
    sourceId: record.envelope?.sourceId ?? record.source.externalId,
    sourceInstanceId: record.envelope?.sourceInstanceId ?? record.source.instanceId,
    sourceVersion: record.envelope?.sourceVersion,
    recordedAt:
      record.envelope?.recordedAt ??
      record.observedAt ??
      record.updatedAt ??
      record.createdAt ??
      record.ingestedAt,
    title: record.envelope?.title ?? record.title,
    url: record.envelope?.url ?? record.source.uri,
    contentHash: record.envelope?.contentHash ?? contentHash,
    participants: record.envelope?.participants ?? normaliseParticipants(record.participants),
    workspace: record.envelope?.workspace,
    parent: record.envelope?.parent,
    entities: record.envelope?.entities ?? record.entities,
    metadata: {
      ...(record.source.account !== undefined ? { account: record.source.account } : {}),
      ...(record.source.collection !== undefined ? { collection: record.source.collection } : {}),
      ...(record.thread !== undefined ? { thread: record.thread } : {}),
      ...(record.metadata ?? {}),
      ...(record.envelope?.metadata ?? {}),
    },
  });
}

function normaliseParticipants(
  participants: Array<Record<string, unknown>> | undefined,
): SourceEnvelope["participants"] | undefined {
  if (participants === undefined) return undefined;
  return participants.map((p) => ({
    ...(typeof p.id === "string" ? { id: p.id } : {}),
    ...(typeof p.name === "string" ? { name: p.name } : {}),
    ...(typeof p.role === "string" ? { role: p.role } : {}),
    ...(typeof p.email === "string" ? { email: p.email } : {}),
    ...p,
  }));
}

export function contentForRecord(record: IngestRecord): string {
  const bits = [record.title, record.body, ...(record.refs ?? []), ...(record.tags ?? [])].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return bits.join("\n");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

export function sourceLedgerPath(homeDir: string): string {
  return resolve(homeDir, "sources", "sources.sqlite");
}

function legacySourceLedgerPath(homeDir: string): string {
  return resolve(homeDir, "sources", "ledger.json");
}

export function sourcesConfigPath(homeDir: string): string {
  return resolve(homeDir, "sources", "sources.json");
}

export function sourceArchivePath(homeDir: string): string {
  return resolve(homeDir, "sources", "archive");
}

export function sourcePackagePath(
  homeDir: string,
  sourceInstanceId: string,
  externalId: string,
): string {
  return resolve(
    sourceArchivePath(homeDir),
    encodePathSegment(sourceInstanceId),
    encodePathSegment(externalId),
  );
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "~");
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function chmodIfExists(path: string, mode: number): void {
  if (!existsSync(path)) return;
  try {
    chmodSync(path, mode);
  } catch {
    // best-effort; writes still happened under a private umask where possible
  }
}

function redactOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redact(value);
}

function redactStringArray(values: string[] | undefined): string[] | undefined {
  return values === undefined ? undefined : values.map((v) => redact(v));
}

export function redactIngestRecord(record: IngestRecord): IngestRecord {
  const envelope = record.envelope;
  return {
    ...record,
    source: {
      ...record.source,
      ...(record.source.uri !== undefined ? { uri: redact(record.source.uri) } : {}),
      ...(record.source.account !== undefined ? { account: redact(record.source.account) } : {}),
      ...(record.source.collection !== undefined ? { collection: redact(record.source.collection) } : {}),
    },
    ...(record.title !== undefined ? { title: redact(record.title) } : {}),
    body: redact(record.body),
    ...(record.summary !== undefined ? { summary: redact(record.summary) } : {}),
    ...(record.author !== undefined ? { author: redactDeep(record.author) as Record<string, unknown> } : {}),
    ...(record.participants !== undefined ? { participants: redactDeep(record.participants) as Array<Record<string, unknown>> } : {}),
    ...(record.refs !== undefined ? { refs: redactStringArray(record.refs) } : {}),
    ...(record.entities !== undefined ? { entities: redactStringArray(record.entities) } : {}),
    ...(record.tags !== undefined ? { tags: redactStringArray(record.tags) } : {}),
    ...(record.thread !== undefined ? { thread: redactDeep(record.thread) as IngestRecord["thread"] } : {}),
    ...(record.attachments !== undefined ? { attachments: redactDeep(record.attachments) as Array<Record<string, unknown>> } : {}),
    ...(record.metadata !== undefined ? { metadata: redactDeep(record.metadata) as Record<string, unknown> } : {}),
    ...(envelope !== undefined
      ? {
          envelope: {
            ...envelope,
            ...(envelope.title !== undefined ? { title: redact(envelope.title) } : {}),
            ...(envelope.url !== undefined ? { url: redact(envelope.url) } : {}),
            ...(envelope.participants !== undefined ? { participants: redactDeep(envelope.participants) as SourceEnvelope["participants"] } : {}),
            ...(envelope.workspace !== undefined ? { workspace: redactDeep(envelope.workspace) as SourceEnvelope["workspace"] } : {}),
            ...(envelope.parent !== undefined ? { parent: redactDeep(envelope.parent) as SourceEnvelope["parent"] } : {}),
            ...(envelope.entities !== undefined ? { entities: redactStringArray(envelope.entities) } : {}),
            ...(envelope.metadata !== undefined ? { metadata: redactDeep(envelope.metadata) as Record<string, unknown> } : {}),
          },
        }
      : {}),
    ...(record.raw !== undefined ? { raw: redactDeep(record.raw) } : {}),
  };
}

type LedgerRow = {
  key: string;
  source_instance_id: string;
  source_kind: string;
  external_id: string;
  uri: string | null;
  title: string | null;
  raw_hash: string;
  discovery_hash: string | null;
  body_hash: string | null;
  content_hash: string;
  extraction_hash: string | null;
  first_ingested_at: string;
  last_ingested_at: string;
  last_seen_at: string;
  updated_at: string | null;
  status: "active" | "failed" | "deleted";
  memory_ids_json: string | null;
  metadata_json: string | null;
  error: string | null;
};

export function readLedger(homeDir: string): Record<string, SourceLedgerEntry> {
  const db = openSourcesDb(homeDir);
  try {
    const rows = db
      .query<LedgerRow, []>(
        `SELECT key, source_instance_id, source_kind, external_id, uri, title,
              raw_hash, discovery_hash, body_hash, content_hash, extraction_hash,
              first_ingested_at, last_ingested_at, last_seen_at, updated_at,
              status, memory_ids_json, metadata_json, error
         FROM source_documents`,
      )
      .all();
    return Object.fromEntries(rows.map((row) => [row.key, rowToLedgerEntry(row)]));
  } finally {
    db.close();
  }
}

export function writeLedger(homeDir: string, ledger: Record<string, SourceLedgerEntry>): void {
  const db = openSourcesDb(homeDir);
  try {
    const upsert = db.query<
      unknown,
      [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO source_documents(
         key, source_instance_id, source_kind, external_id, uri, title,
         raw_hash, discovery_hash, body_hash, content_hash, extraction_hash,
         first_ingested_at, last_ingested_at, last_seen_at, updated_at, status,
         memory_ids_json, error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         source_kind = excluded.source_kind,
         uri = excluded.uri,
         title = excluded.title,
         raw_hash = excluded.raw_hash,
         discovery_hash = excluded.discovery_hash,
         body_hash = excluded.body_hash,
         content_hash = excluded.content_hash,
         extraction_hash = excluded.extraction_hash,
         last_ingested_at = excluded.last_ingested_at,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at,
         status = excluded.status,
         memory_ids_json = excluded.memory_ids_json,
         error = excluded.error`,
    );
    const tx = db.transaction(() => {
      for (const entry of Object.values(ledger)) {
        upsert.run(
          entry.key,
          entry.sourceInstanceId,
          entry.sourceKind,
          entry.externalId,
          entry.uri ?? null,
          entry.title ?? null,
          entry.rawHash,
          entry.rawHash,
          entry.contentHash,
          entry.contentHash,
          entry.contentHash,
          entry.firstIngestedAt,
          entry.lastIngestedAt,
          entry.lastSeenAt,
          entry.updatedAt ?? null,
          entry.status,
          entry.memoryIds === undefined ? null : JSON.stringify(entry.memoryIds),
          entry.error ?? null,
        );
      }
    });
    tx();
  } finally {
    db.close();
  }
}

function openSourcesDb(homeDir: string): Database {
  const p = sourceLedgerPath(homeDir);
  ensurePrivateDir(dirname(p));
  const previousUmask = process.umask(0o077);
  let db: Database | undefined;
  try {
    db = new Database(p);
    chmodIfExists(p, 0o600);
    db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS source_instances (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      type TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule TEXT,
      mode TEXT,
      config_json TEXT,
      connector_version TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS source_documents (
      key TEXT PRIMARY KEY,
      source_instance_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      external_id TEXT NOT NULL,
      uri TEXT,
      title TEXT,
      body TEXT NOT NULL DEFAULT '',
      body_format TEXT,
      summary TEXT,
      collection TEXT,
      thread_id TEXT,
      raw_hash TEXT NOT NULL,
      discovery_hash TEXT,
      body_hash TEXT,
      content_hash TEXT NOT NULL,
      extraction_hash TEXT,
      first_ingested_at TEXT NOT NULL,
      first_seen_at TEXT,
      last_ingested_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','failed','deleted')),
      memory_ids_json TEXT,
      metadata_json TEXT,
      error TEXT,
      UNIQUE(source_instance_id, external_id)
    );
    CREATE INDEX IF NOT EXISTS source_documents_instance_idx ON source_documents(source_instance_id);
    CREATE INDEX IF NOT EXISTS source_documents_content_hash_idx ON source_documents(content_hash);
    CREATE VIRTUAL TABLE IF NOT EXISTS source_documents_fts USING fts5(
      key UNINDEXED,
      title,
      body,
      refs,
      tokenize = 'porter unicode61'
    );
    CREATE TABLE IF NOT EXISTS source_cursors (
      source_instance_id TEXT PRIMARY KEY,
      cursor_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_ingest_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_instance_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      external_id TEXT,
      decision TEXT NOT NULL,
      content_hash TEXT,
      summary TEXT NOT NULL DEFAULT '',
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source_document_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      extraction_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','done','failed')),
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS source_jobs_status_available_idx ON source_jobs(status, available_at, priority);
    CREATE INDEX IF NOT EXISTS source_jobs_document_idx ON source_jobs(source_document_key);
  `);
  try {
    db.exec("ALTER TABLE source_documents ADD COLUMN first_seen_at TEXT");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE source_documents ADD COLUMN body TEXT NOT NULL DEFAULT ''");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE source_documents ADD COLUMN body_format TEXT");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE source_documents ADD COLUMN summary TEXT");
  } catch {
    /* already exists */
  }
    migrateLegacyLedger(homeDir, db);
    chmodIfExists(p, 0o600);
    chmodIfExists(`${p}-wal`, 0o600);
    chmodIfExists(`${p}-shm`, 0o600);
    return db;
  } catch (err) {
    db?.close();
    throw err;
  } finally {
    process.umask(previousUmask);
  }
}

function migrateLegacyLedger(homeDir: string, db: Database): void {
  const marker = resolve(homeDir, "sources", ".ledger-json-migrated");
  const legacy = legacySourceLedgerPath(homeDir);
  if (existsSync(marker) || !existsSync(legacy)) return;
  const parsed = JSON.parse(readFileSync(legacy, "utf8")) as Record<string, SourceLedgerEntry>;
  if (Object.keys(parsed).length > 0) writeLedgerWithDb(db, parsed);
  atomicWrite(marker, `${new Date().toISOString()}\n`);
}

function writeLedgerWithDb(db: Database, ledger: Record<string, SourceLedgerEntry>): void {
  const upsert = db.query<
    unknown,
    [
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | null,
      string,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO source_documents(
       key, source_instance_id, source_kind, external_id, uri, title,
       raw_hash, discovery_hash, body_hash, content_hash, extraction_hash,
       first_ingested_at, last_ingested_at, last_seen_at, updated_at, status,
       memory_ids_json, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO NOTHING`,
  );
  const tx = db.transaction(() => {
    for (const entry of Object.values(ledger)) {
      upsert.run(
        entry.key,
        entry.sourceInstanceId,
        entry.sourceKind,
        entry.externalId,
        entry.uri ?? null,
        entry.title ?? null,
        entry.rawHash,
        entry.rawHash,
        entry.contentHash,
        entry.contentHash,
        entry.contentHash,
        entry.firstIngestedAt,
        entry.lastIngestedAt,
        entry.lastSeenAt,
        entry.updatedAt ?? null,
        entry.status,
        entry.memoryIds === undefined ? null : JSON.stringify(entry.memoryIds),
        entry.error ?? null,
      );
    }
  });
  tx();
}

function rowToLedgerEntry(row: LedgerRow): SourceLedgerEntry {
  return {
    key: row.key,
    sourceInstanceId: row.source_instance_id,
    sourceKind: row.source_kind,
    externalId: row.external_id,
    ...(row.uri !== null ? { uri: row.uri } : {}),
    ...(row.title !== null ? { title: row.title } : {}),
    rawHash: row.raw_hash,
    contentHash: row.content_hash,
    firstIngestedAt: row.first_ingested_at,
    lastIngestedAt: row.last_ingested_at,
    lastSeenAt: row.last_seen_at,
    ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
    status: row.status,
    ...(row.memory_ids_json !== null
      ? { memoryIds: JSON.parse(row.memory_ids_json) as string[] }
      : {}),
    ...(row.error !== null ? { error: row.error } : {}),
  };
}

export function readSourcesConfig(homeDir: string): SourcesConfig {
  const p = sourcesConfigPath(homeDir);
  if (!existsSync(p)) return { sources: [] };
  const parsed = JSON.parse(readFileSync(p, "utf8")) as SourcesConfig;
  return { sources: Array.isArray(parsed.sources) ? parsed.sources : [] };
}

export function writeSourcesConfig(homeDir: string, config: SourcesConfig): void {
  const p = sourcesConfigPath(homeDir);
  atomicWrite(p, `${JSON.stringify(config, null, 2)}\n`);
  upsertSourceInstances(homeDir, config.sources);
}

function upsertSourceInstances(homeDir: string, sources: readonly SourceConfig[]): void {
  const db = openSourcesDb(homeDir);
  try {
    const now = new Date().toISOString();
    const stmt = db.query<
      unknown,
      [string, string, string, number, string | null, string | null, string | null, string]
    >(
      `INSERT INTO source_instances(id, kind, type, enabled, schedule, mode, config_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         type = excluded.type,
         enabled = excluded.enabled,
         schedule = excluded.schedule,
         mode = excluded.mode,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
    );
    const tx = db.transaction(() => {
      for (const source of sources) {
        stmt.run(
          source.id,
          source.kind,
          source.type,
          source.enabled === false ? 0 : 1,
          source.schedule ?? null,
          source.mode ?? null,
          source.config === undefined ? null : stableJson(source.config),
          now,
        );
      }
    });
    tx();
  } finally {
    db.close();
  }
}

export function decideAndUpdateLedger(
  homeDir: string,
  input: IngestRecord,
  now = new Date().toISOString(),
): { decision: IngestDecision; entry: SourceLedgerEntry } {
  const record = redactIngestRecord(input);
  const db = openSourcesDb(homeDir);
  try {
    const key = sourceKey(record);
    const rawHash = sha256(stableJson(record.raw ?? record));
    const discoveryHash = sha256(
      stableJson({
        title: record.title,
        summary: record.summary,
        metadata: record.metadata,
        refs: record.refs,
        tags: record.tags,
      }),
    );
    const bodyHash = sha256(record.body);
    const contentHash = sha256(contentForRecord(record));
    const extractionHash = sha256(
      stableJson({
        title: record.title,
        body: record.body,
        refs: record.refs,
        entities: record.entities,
        thread: record.thread,
      }),
    );
    const existing =
      db
        .query<LedgerRow, [string]>(
          `SELECT key, source_instance_id, source_kind, external_id, uri, title,
              raw_hash, discovery_hash, body_hash, content_hash, extraction_hash,
              first_ingested_at, last_ingested_at, last_seen_at, updated_at,
              status, memory_ids_json, metadata_json, error
         FROM source_documents WHERE key = ?`,
        )
        .get(key) ?? undefined;
    const decision: IngestDecision =
      existing === undefined
        ? "created"
        : existing.content_hash === contentHash
          ? "unchanged"
          : "updated";
    const firstIngestedAt = existing?.first_ingested_at ?? now;
    const memoryIds = existing?.memory_ids_json ?? null;
    db.query<
      unknown,
      [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO source_documents(
         key, source_instance_id, source_kind, external_id, uri, title, body,
         body_format, summary, collection, thread_id, raw_hash, discovery_hash, body_hash, content_hash,
         extraction_hash, first_ingested_at, first_seen_at, last_ingested_at, last_seen_at,
         updated_at, status, memory_ids_json, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         source_kind = excluded.source_kind,
         uri = excluded.uri,
         title = excluded.title,
         body = excluded.body,
         body_format = excluded.body_format,
         summary = excluded.summary,
         collection = excluded.collection,
         thread_id = excluded.thread_id,
         raw_hash = excluded.raw_hash,
         discovery_hash = excluded.discovery_hash,
         body_hash = excluded.body_hash,
         content_hash = excluded.content_hash,
         extraction_hash = excluded.extraction_hash,
         last_ingested_at = excluded.last_ingested_at,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at,
         status = excluded.status,
         memory_ids_json = excluded.memory_ids_json,
         metadata_json = excluded.metadata_json,
         error = NULL`,
    ).run(
      key,
      record.source.instanceId,
      record.source.kind,
      record.source.externalId,
      record.source.uri ?? null,
      record.title ?? null,
      record.body,
      record.bodyFormat ?? null,
      record.summary ?? null,
      record.source.collection ?? null,
      record.thread?.id ?? null,
      rawHash,
      discoveryHash,
      bodyHash,
      contentHash,
      extractionHash,
      firstIngestedAt,
      existing?.first_ingested_at ?? now,
      now,
      now,
      record.updatedAt ?? null,
      "active",
      memoryIds,
      record.metadata === undefined ? null : stableJson(record.metadata),
    );
    writeSourcePackage(homeDir, record, {
      rawHash,
      discoveryHash,
      bodyHash,
      contentHash,
      extractionHash,
      firstIngestedAt,
      firstSeenAt: existing?.first_ingested_at ?? now,
      lastIngestedAt: now,
      lastSeenAt: now,
    });
    upsertSourceDocumentFts(db, key, record);
    db.query<unknown, [string, string, string, string, string, string, string]>(
      `INSERT INTO source_ingest_log(source_instance_id, source_kind, external_id, decision, content_hash, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.source.instanceId,
      record.source.kind,
      record.source.externalId,
      decision,
      contentHash,
      record.title ?? "",
      now,
    );
    const entry = rowToLedgerEntry({
      key,
      source_instance_id: record.source.instanceId,
      source_kind: record.source.kind,
      external_id: record.source.externalId,
      uri: record.source.uri ?? null,
      title: record.title ?? null,
      raw_hash: rawHash,
      discovery_hash: discoveryHash,
      body_hash: bodyHash,
      content_hash: contentHash,
      extraction_hash: extractionHash,
      first_ingested_at: firstIngestedAt,
      last_ingested_at: now,
      last_seen_at: now,
      updated_at: record.updatedAt ?? null,
      status: "active",
      memory_ids_json: memoryIds,
      metadata_json: record.metadata === undefined ? null : stableJson(record.metadata),
      error: null,
    });
    return { decision, entry };
  } finally {
    db.close();
  }
}

type SourcePackageHashes = {
  rawHash: string;
  discoveryHash: string;
  bodyHash: string;
  contentHash: string;
  extractionHash: string;
  firstIngestedAt: string;
  firstSeenAt: string;
  lastIngestedAt: string;
  lastSeenAt: string;
};

function writeSourcePackage(
  homeDir: string,
  record: IngestRecord,
  hashes: SourcePackageHashes,
): void {
  const dir = sourcePackagePath(homeDir, record.source.instanceId, record.source.externalId);
  ensurePrivateDir(sourceArchivePath(homeDir));
  ensurePrivateDir(dirname(dir));
  ensurePrivateDir(dir);
  const envelope = sourceEnvelopeForRecord(record);
  const fm: Frontmatter = {
    schema: "brain.source.v1",
    source_instance_id: record.source.instanceId,
    source_kind: record.source.kind,
    external_id: record.source.externalId,
    title: record.title ?? "",
    raw_hash: hashes.rawHash,
    discovery_hash: hashes.discoveryHash,
    body_hash: hashes.bodyHash,
    content_hash: hashes.contentHash,
    extraction_hash: hashes.extractionHash,
    first_ingested_at: hashes.firstIngestedAt,
    first_seen_at: hashes.firstSeenAt,
    last_ingested_at: hashes.lastIngestedAt,
    last_seen_at: hashes.lastSeenAt,
    status: "active",
    origin: "external",
    envelope_schema: SOURCE_ENVELOPE_SCHEMA,
    envelope_source_kind: envelope.sourceKind,
    envelope_source_id: envelope.sourceId,
    refs: record.refs ?? [],
    tags: record.tags ?? [],
  };
  if (record.source.uri !== undefined) fm.uri = record.source.uri;
  if (record.bodyFormat !== undefined) fm.body_format = record.bodyFormat;
  if (record.summary !== undefined) fm.summary = record.summary;
  if (record.source.collection !== undefined) fm.collection = record.source.collection;
  if (record.thread?.id !== undefined) fm.thread_id = record.thread.id;
  if (record.updatedAt !== undefined) fm.updated_at = record.updatedAt;
  if (record.createdAt !== undefined) fm.created_at = record.createdAt;
  if (record.observedAt !== undefined) fm.observed_at = record.observedAt;
  if (record.attachments !== undefined) fm.attachment_count = record.attachments.length;
  atomicWrite(resolve(dir, "source.md"), serialise(fm, record.body));
  atomicWrite(
    resolve(dir, "envelope.json"),
    `${stableJson({ ...envelope, schema: SOURCE_ENVELOPE_SCHEMA })}\n`,
  );
  if (record.raw !== undefined)
    atomicWrite(resolve(dir, "raw.json"), `${stableJson(record.raw)}\n`);
  ensurePrivateDir(resolve(dir, "attachments"));
  ensurePrivateDir(resolve(dir, "extracted"));
  ensurePrivateDir(resolve(dir, "thumbnails"));
}

function atomicWrite(path: string, content: string): void {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodIfExists(tmp, 0o600);
  renameSync(tmp, path);
  chmodIfExists(path, 0o600);
}

export function rebuildSourceIndexFromArchive(homeDir: string): { packages: number } {
  const db = openSourcesDb(homeDir);
  try {
    db.exec("DELETE FROM source_documents_fts; DELETE FROM source_documents;");
  } finally {
    db.close();
  }
  let packages = 0;
  for (const sourceFile of findSourcePackageFiles(sourceArchivePath(homeDir))) {
    const record = readSourcePackageFile(sourceFile);
    if (record !== undefined) {
      decideAndUpdateLedger(homeDir, record);
      packages++;
    }
  }
  return { packages };
}

function findSourcePackageFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name === "source.md") out.push(p);
    }
  };
  walk(root);
  return out;
}

function readSourcePackageFile(path: string): IngestRecord | undefined {
  const parsed = parseFrontmatter(readFileSync(path, "utf8"));
  const envelope = readSourcePackageEnvelope(dirname(path));
  const fm = parsed.frontmatter;
  if (fm.schema !== "brain.source.v1") return undefined;
  const sourceInstanceId = asString(fm.source_instance_id);
  const sourceKind = asString(fm.source_kind);
  const externalId = asString(fm.external_id);
  if (!sourceInstanceId || !sourceKind || !externalId || parsed.body.trim() === "")
    return undefined;
  return {
    schema: INGEST_SCHEMA,
    source: {
      instanceId: sourceInstanceId,
      kind: sourceKind,
      externalId,
      ...(asString(fm.uri) !== undefined ? { uri: asString(fm.uri) } : {}),
      ...(asString(fm.collection) !== undefined ? { collection: asString(fm.collection) } : {}),
    },
    ...(asString(fm.title) !== undefined && asString(fm.title) !== ""
      ? { title: asString(fm.title) }
      : {}),
    body: parsed.body,
    ...(isBodyFormat(asString(fm.body_format))
      ? { bodyFormat: asString(fm.body_format) as "text" | "markdown" | "html" | "json" }
      : {}),
    ...(asString(fm.summary) !== undefined ? { summary: asString(fm.summary) } : {}),
    ...(asString(fm.created_at) !== undefined ? { createdAt: asString(fm.created_at) } : {}),
    ...(asString(fm.updated_at) !== undefined ? { updatedAt: asString(fm.updated_at) } : {}),
    ...(asString(fm.observed_at) !== undefined ? { observedAt: asString(fm.observed_at) } : {}),
    ...(Array.isArray(fm.refs) ? { refs: fm.refs } : {}),
    ...(Array.isArray(fm.tags) ? { tags: fm.tags } : {}),
    ...(asString(fm.thread_id) !== undefined
      ? { thread: { id: asString(fm.thread_id) as string } }
      : {}),
    ...(envelope !== undefined ? { envelope } : {}),
  };
}

function readSourcePackageEnvelope(dir: string): SourceEnvelope | undefined {
  const path = resolve(dir, "envelope.json");
  if (!existsSync(path)) return undefined;
  try {
    return SourceEnvelopeSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isBodyFormat(value: string | undefined): boolean {
  return value === "text" || value === "markdown" || value === "html" || value === "json";
}

function upsertSourceDocumentFts(db: Database, key: string, record: IngestRecord): void {
  db.query<unknown, [string]>("DELETE FROM source_documents_fts WHERE key = ?").run(key);
  db.query<unknown, [string, string, string, string]>(
    "INSERT INTO source_documents_fts(key, title, body, refs) VALUES (?, ?, ?, ?)",
  ).run(key, record.title ?? "", record.body, (record.refs ?? []).join(" "));
}

export type SourceSearchHit = {
  key: string;
  sourceInstanceId: string;
  sourceKind: string;
  externalId: string;
  title?: string;
  body: string;
  uri?: string;
  updatedAt?: string;
  score: number;
};

export function searchSourceDocuments(
  homeDir: string,
  query: string,
  limit = 10,
): SourceSearchHit[] {
  const expr = compileSourceFtsQuery(query);
  if (expr === "") return [];
  const db = openSourcesDb(homeDir);
  try {
    const rows = db
      .query<
        {
          key: string;
          source_instance_id: string;
          source_kind: string;
          external_id: string;
          title: string | null;
          body: string;
          uri: string | null;
          updated_at: string | null;
          score: number;
        },
        [string, number]
      >(
        `SELECT d.key, d.source_instance_id, d.source_kind, d.external_id,
              d.title, d.body, d.uri, d.updated_at,
              bm25(source_documents_fts) AS score
         FROM source_documents_fts
         JOIN source_documents d ON d.key = source_documents_fts.key
        WHERE source_documents_fts MATCH ?
          AND d.status = 'active'
        ORDER BY score
        LIMIT ?`,
      )
      .all(expr, Math.max(1, Math.min(100, limit)));
    return rows.map((row) => ({
      key: row.key,
      sourceInstanceId: row.source_instance_id,
      sourceKind: row.source_kind,
      externalId: row.external_id,
      ...(row.title !== null ? { title: row.title } : {}),
      body: row.body,
      ...(row.uri !== null ? { uri: row.uri } : {}),
      ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
      score: -row.score,
    }));
  } finally {
    db.close();
  }
}

function compileSourceFtsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 16);
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

type SourceDocumentRow = {
  key: string;
  source_instance_id: string;
  source_kind: string;
  external_id: string;
  uri: string | null;
  title: string | null;
  body: string;
  body_format: string | null;
  summary: string | null;
  updated_at: string | null;
  content_hash: string;
  extraction_hash: string | null;
};

export function listRecentSourceDocumentRecords(homeDir: string, limit = 100): IngestRecord[] {
  const db = openSourcesDb(homeDir);
  try {
    const rows = db
      .query<{ key: string }, [number]>(
        `SELECT key FROM source_documents
        WHERE status = 'active'
        ORDER BY COALESCE(updated_at, last_seen_at, last_ingested_at) DESC
        LIMIT ?`,
      )
      .all(Math.max(1, Math.min(1000, limit)));
    return rows
      .map((row) => readSourceDocumentRecord(homeDir, row.key))
      .filter((record): record is IngestRecord => record !== undefined);
  } finally {
    db.close();
  }
}

export function readSourceDocumentRecord(homeDir: string, key: string): IngestRecord | undefined {
  const db = openSourcesDb(homeDir);
  try {
    const row =
      db
        .query<SourceDocumentRow, [string]>(
          `SELECT key, source_instance_id, source_kind, external_id, uri, title, body,
              body_format, summary, updated_at, content_hash, extraction_hash
         FROM source_documents
        WHERE key = ? AND status = 'active'`,
        )
        .get(key) ?? undefined;
    if (row === undefined) return undefined;
    const envelope = readSourcePackageEnvelope(
      sourcePackagePath(homeDir, row.source_instance_id, row.external_id),
    );
    return {
      schema: INGEST_SCHEMA,
      source: {
        instanceId: row.source_instance_id,
        kind: row.source_kind,
        externalId: row.external_id,
        ...(row.uri !== null ? { uri: row.uri } : {}),
      },
      ...(row.title !== null ? { title: row.title } : {}),
      body: row.body,
      ...(row.body_format === "text" ||
      row.body_format === "markdown" ||
      row.body_format === "html" ||
      row.body_format === "json"
        ? { bodyFormat: row.body_format }
        : {}),
      ...(row.summary !== null ? { summary: row.summary } : {}),
      ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
      ...(envelope !== undefined ? { envelope } : {}),
    };
  } finally {
    db.close();
  }
}

export function enqueueSourceEnrichmentJob(
  homeDir: string,
  entry: SourceLedgerEntry,
  now = new Date().toISOString(),
): SourceEnrichmentJob {
  const db = openSourcesDb(homeDir);
  try {
    const row = db
      .query<{ extraction_hash: string | null }, [string]>(
        "SELECT extraction_hash FROM source_documents WHERE key = ?",
      )
      .get(entry.key);
    const extractionHash = row?.extraction_hash ?? entry.contentHash;
    const id = `extract-source-doc:${entry.key}:${extractionHash}`;
    db.query<unknown, [string, string, string, string, string, number, string, string, string]>(
      `INSERT INTO source_jobs(id, type, source_document_key, content_hash, extraction_hash, status, priority, available_at, created_at, updated_at)
       VALUES (?, 'extract-source-doc', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content_hash = excluded.content_hash,
         extraction_hash = excluded.extraction_hash,
         status = CASE WHEN source_jobs.status = 'done' THEN source_jobs.status ELSE 'pending' END,
         available_at = CASE WHEN source_jobs.status = 'done' THEN source_jobs.available_at ELSE excluded.available_at END,
         updated_at = excluded.updated_at`,
    ).run(id, entry.key, entry.contentHash, extractionHash, "pending", 0, now, now, now);
    const created = readSourceJobWithDb(db, id);
    if (created === undefined) throw new Error(`source job insert failed: ${id}`);
    return created;
  } finally {
    db.close();
  }
}

export function listSourceEnrichmentJobs(homeDir: string, limit = 50): SourceEnrichmentJob[] {
  const db = openSourcesDb(homeDir);
  try {
    return db
      .query<SourceJobRow, [number]>(
        `SELECT id, type, source_document_key, content_hash, extraction_hash, status, priority,
              attempts, available_at, created_at, updated_at, error
         FROM source_jobs
        ORDER BY status, priority DESC, created_at
        LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, limit)))
      .map(rowToSourceJob);
  } finally {
    db.close();
  }
}

export function claimSourceEnrichmentJobs(
  homeDir: string,
  limit = 10,
  now = new Date().toISOString(),
): SourceEnrichmentJob[] {
  const db = openSourcesDb(homeDir);
  try {
    const rows = db
      .query<SourceJobRow, [string, number]>(
        `SELECT id, type, source_document_key, content_hash, extraction_hash, status, priority,
              attempts, available_at, created_at, updated_at, error
         FROM source_jobs
        WHERE status = 'pending' AND available_at <= ?
        ORDER BY priority DESC, created_at
        LIMIT ?`,
      )
      .all(now, Math.max(1, Math.min(100, limit)));
    const mark = db.query<unknown, [string, string]>(
      "UPDATE source_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
    );
    const claimed: SourceEnrichmentJob[] = [];
    for (const row of rows) {
      if (mark.run(now, row.id).changes > 0) {
        const reread = readSourceJobWithDb(db, row.id);
        if (reread) claimed.push(reread);
      }
    }
    return claimed;
  } finally {
    db.close();
  }
}

export function completeSourceEnrichmentJob(
  homeDir: string,
  id: string,
  now = new Date().toISOString(),
): void {
  const db = openSourcesDb(homeDir);
  try {
    db.query<unknown, [string, string]>(
      "UPDATE source_jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?",
    ).run(now, id);
  } finally {
    db.close();
  }
}

export function failSourceEnrichmentJob(
  homeDir: string,
  id: string,
  error: string,
  now = new Date().toISOString(),
): void {
  const db = openSourcesDb(homeDir);
  try {
    const row = readSourceJobWithDb(db, id);
    if (row === undefined) return;
    if (row.attempts >= SOURCE_JOB_MAX_ATTEMPTS) {
      db.query<unknown, [string, string, string]>(
        "UPDATE source_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
      ).run(error, now, id);
      return;
    }
    const availableAt = sourceJobBackoffAvailableAt(row.attempts, now);
    db.query<unknown, [string, string, string, string]>(
      "UPDATE source_jobs SET status = 'pending', error = ?, available_at = ?, updated_at = ? WHERE id = ?",
    ).run(error, availableAt, now, id);
  } finally {
    db.close();
  }
}

export function sourceJobBackoffAvailableAt(attempts: number, now: string): string {
  const exponent = Math.max(0, attempts - 1);
  const delayMs = Math.min(SOURCE_JOB_BACKOFF_MAX_MS, SOURCE_JOB_BACKOFF_BASE_MS * 2 ** exponent);
  return new Date(Date.parse(now) + delayMs).toISOString();
}

type SourceJobRow = {
  id: string;
  type: "extract-source-doc";
  source_document_key: string;
  content_hash: string;
  extraction_hash: string;
  status: SourceJobStatus;
  priority: number;
  attempts: number;
  available_at: string;
  created_at: string;
  updated_at: string;
  error: string | null;
};

function readSourceJobWithDb(db: Database, id: string): SourceEnrichmentJob | undefined {
  const row =
    db
      .query<SourceJobRow, [string]>(
        `SELECT id, type, source_document_key, content_hash, extraction_hash, status, priority,
            attempts, available_at, created_at, updated_at, error
       FROM source_jobs WHERE id = ?`,
      )
      .get(id) ?? undefined;
  return row === undefined ? undefined : rowToSourceJob(row);
}

function rowToSourceJob(row: SourceJobRow): SourceEnrichmentJob {
  return {
    id: row.id,
    type: row.type,
    sourceDocumentKey: row.source_document_key,
    contentHash: row.content_hash,
    extractionHash: row.extraction_hash,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    availableAt: row.available_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error !== null ? { error: row.error } : {}),
  };
}

export function markSourceDocumentDeleted(
  homeDir: string,
  sourceInstanceId: string,
  externalId: string,
  now = new Date().toISOString(),
): boolean {
  const db = openSourcesDb(homeDir);
  try {
    const key = `${sourceInstanceId}:${externalId}`;
    const result = db
      .query<unknown, [string, string]>(
        "UPDATE source_documents SET status = 'deleted', last_seen_at = ? WHERE key = ?",
      )
      .run(now, key);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function renderRecordForMemory(record: IngestRecord): string {
  const envelope = sourceEnvelopeForRecord(record);
  const workspace = envelope.workspace;
  const lines = [
    record.title !== undefined ? `# ${record.title}` : undefined,
    `Source: ${envelope.sourceKind} ${envelope.sourceId}`,
    envelope.url !== undefined ? `URL: ${envelope.url}` : undefined,
    envelope.title !== undefined && envelope.title !== record.title
      ? `Source title: ${envelope.title}`
      : undefined,
    workspace?.projectName !== undefined ? `Project: ${workspace.projectName}` : undefined,
    workspace?.gitRepo !== undefined ? `Repository: ${workspace.gitRepo}` : undefined,
    workspace?.cwd !== undefined ? `Working directory: ${workspace.cwd}` : undefined,
    workspace?.branch !== undefined ? `Branch: ${workspace.branch}` : undefined,
    record.author !== undefined
      ? `Author: ${String(record.author.name ?? record.author.email ?? record.author.id ?? "")}`
      : undefined,
    envelope.participants?.length
      ? `Participants: ${envelope.participants.map((p) => p.name ?? p.email ?? p.id ?? p.role ?? "unknown").join(", ")}`
      : undefined,
    record.createdAt !== undefined ? `Created: ${record.createdAt}` : undefined,
    record.updatedAt !== undefined ? `Updated: ${record.updatedAt}` : undefined,
    envelope.recordedAt !== undefined ? `Recorded: ${envelope.recordedAt}` : undefined,
    record.refs?.length ? `Refs: ${record.refs.join(", ")}` : undefined,
    "",
    record.body,
  ];
  return lines.filter((v): v is string => v !== undefined).join("\n");
}

export function parseJsonlRecords(text: string): {
  records: IngestRecord[];
  checkpoint?: unknown;
  logs: string[];
} {
  const records: IngestRecord[] = [];
  const logs: string[] = [];
  let checkpoint: unknown;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = JSON.parse(trimmed) as unknown;
    const obj = parsed as Record<string, unknown>;
    if (obj.type === "record") {
      const rec = IngestRecordSchema.parse(obj.record);
      records.push({ ...rec, schema: INGEST_SCHEMA });
    } else if (obj.type === "checkpoint") {
      checkpoint = obj.cursor;
    } else if (obj.type === "log") {
      logs.push(String(obj.message ?? ""));
    } else {
      const rec = IngestRecordSchema.parse(parsed);
      records.push({ ...rec, schema: INGEST_SCHEMA });
    }
  }
  return { records, checkpoint, logs };
}

export function runCommandConnector(source: SourceConfig, cursor: unknown): Promise<string> {
  if (!source.command) throw new Error(`source ${source.id} has no command`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(source.command as string, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        BRAIN_SOURCE_INSTANCE: source.id,
        BRAIN_SOURCE_KIND: source.kind,
        BRAIN_CURSOR_JSON: JSON.stringify(cursor ?? null),
        BRAIN_CONNECTOR_CONFIG_JSON: JSON.stringify(source.config ?? {}),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(stderr || `connector exited ${code}`));
    });
  });
}

export function cursorPath(homeDir: string, sourceId: string): string {
  return resolve(
    homeDir,
    "sources",
    "cursors",
    `${sourceId.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`,
  );
}

export function readCursor(homeDir: string, sourceId: string): unknown {
  const db = openSourcesDb(homeDir);
  try {
    const row = db
      .query<{ cursor_json: string }, [string]>(
        "SELECT cursor_json FROM source_cursors WHERE source_instance_id = ?",
      )
      .get(sourceId);
    if (row !== null) return JSON.parse(row.cursor_json);
  } finally {
    db.close();
  }
  const p = cursorPath(homeDir, sourceId);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function writeCursor(homeDir: string, sourceId: string, cursor: unknown): void {
  const db = openSourcesDb(homeDir);
  try {
    db.query<unknown, [string, string, string]>(
      `INSERT INTO source_cursors(source_instance_id, cursor_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(source_instance_id) DO UPDATE SET
         cursor_json = excluded.cursor_json,
         updated_at = excluded.updated_at`,
    ).run(sourceId, JSON.stringify(cursor), new Date().toISOString());
  } finally {
    db.close();
  }
}
