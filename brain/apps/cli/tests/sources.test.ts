import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimSourceEnrichmentJobs,
  completeSourceEnrichmentJob,
  decideAndUpdateLedger,
  enqueueSourceEnrichmentJob,
  failSourceEnrichmentJob,
  type IngestRecord,
  listSourceEnrichmentJobs,
  markSourceDocumentDeleted,
  readCursor,
  readLedger,
  readSourceDocumentRecord,
  rebuildSourceIndexFromArchive,
  searchSourceDocuments,
  sourceArchivePath,
  sourceLedgerPath,
  sourcePackagePath,
  writeCursor,
  writeSourcesConfig,
} from "../src/shared/sources.ts";

describe("sources ledger", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brain-sources-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const record = (body = "hello", metadata?: Record<string, unknown>): IngestRecord => ({
    schema: "brain.ingest.v1",
    source: {
      instanceId: "gmail:me",
      kind: "gmail",
      externalId: "msg-1",
      uri: "https://mail/msg-1",
    },
    title: "Subject",
    body,
    updatedAt: "2026-05-14T00:00:00Z",
    ...(metadata !== undefined ? { metadata } : {}),
  });

  it("stores source documents in SQLite and detects unchanged/updated records", () => {
    expect(decideAndUpdateLedger(dir, record()).decision).toBe("created");
    expect(decideAndUpdateLedger(dir, record()).decision).toBe("unchanged");
    expect(decideAndUpdateLedger(dir, record("changed")).decision).toBe("updated");

    const ledger = readLedger(dir);
    const entry = ledger["gmail:me:msg-1"];
    expect(entry?.sourceKind).toBe("gmail");
    expect(entry?.title).toBe("Subject");

    const db = new Database(sourceLedgerPath(dir));
    try {
      const row = db
        .query<{ body_hash: string; extraction_hash: string }, []>(
          "SELECT body_hash, extraction_hash FROM source_documents",
        )
        .get();
      expect(row?.body_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(row?.extraction_hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      db.close();
    }
  });

  it("keeps metadata-only changes out of extraction hash", () => {
    decideAndUpdateLedger(dir, record("same", { labels: ["INBOX"] }));
    const db = new Database(sourceLedgerPath(dir));
    const before = db
      .query<{ extraction_hash: string }, []>("SELECT extraction_hash FROM source_documents")
      .get()?.extraction_hash;
    db.close();

    decideAndUpdateLedger(dir, record("same", { labels: ["INBOX", "STARRED"] }));
    const db2 = new Database(sourceLedgerPath(dir));
    const after = db2
      .query<{ extraction_hash: string }, []>("SELECT extraction_hash FROM source_documents")
      .get()?.extraction_hash;
    db2.close();
    expect(after).toBe(before);
  });

  it("redacts secrets before writing source SQLite, FTS, packages, and raw archives", () => {
    const secret = "supersecret123456";
    decideAndUpdateLedger(dir, {
      ...record(`The deployment token is api_key=${secret}.`),
      metadata: { nested: `auth_token=${secret}` },
      raw: { transcript: `password=${secret}` },
    });
    const doc = readSourceDocumentRecord(dir, "gmail:me:msg-1");
    expect(JSON.stringify(doc)).not.toContain(secret);
    expect(doc?.body).toContain("[REDACTED]");
    expect(searchSourceDocuments(dir, secret, 5)).toHaveLength(0);
    expect(searchSourceDocuments(dir, "REDACTED", 5)).toHaveLength(1);
    const pkg = sourcePackagePath(dir, "gmail:me", "msg-1");
    expect(readFileSync(join(pkg, "source.md"), "utf8")).not.toContain(secret);
    expect(readFileSync(join(pkg, "raw.json"), "utf8")).not.toContain(secret);
  });

  it("writes source stores and archives with private permissions", () => {
    decideAndUpdateLedger(dir, { ...record("private body"), raw: { body: "private body" } });
    writeSourcesConfig(dir, { sources: [{ id: "gmail:me", type: "inbox", kind: "gmail" }] });
    const pkg = sourcePackagePath(dir, "gmail:me", "msg-1");
    expect(statSync(join(dir, "sources")).mode & 0o777).toBe(0o700);
    expect(statSync(sourceLedgerPath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "sources", "sources.json")).mode & 0o777).toBe(0o600);
    expect(statSync(sourceArchivePath(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(pkg).mode & 0o777).toBe(0o700);
    expect(statSync(join(pkg, "source.md")).mode & 0o777).toBe(0o600);
    expect(statSync(join(pkg, "raw.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(pkg, "attachments")).mode & 0o777).toBe(0o700);
  });

  it("writes file-backed source packages with source envelopes", () => {
    decideAndUpdateLedger(dir, {
      ...record("archived body"),
      envelope: {
        sourceKind: "gmail-message",
        sourceId: "msg-1",
        title: "Subject",
        workspace: { projectName: "mailbox" },
        metadata: { label: "INBOX" },
      },
    });
    const pkg = sourcePackagePath(dir, "gmail:me", "msg-1");
    expect(existsSync(join(pkg, "source.md"))).toBe(true);
    expect(existsSync(join(pkg, "envelope.json"))).toBe(true);
    expect(existsSync(join(pkg, "attachments"))).toBe(true);
    expect(existsSync(join(pkg, "extracted"))).toBe(true);
    expect(existsSync(join(pkg, "thumbnails"))).toBe(true);
    const envelope = JSON.parse(readFileSync(join(pkg, "envelope.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(envelope.sourceKind).toBe("gmail-message");
    expect(envelope.sourceId).toBe("msg-1");
    expect(readSourceDocumentRecord(dir, "gmail:me:msg-1")?.envelope?.workspace?.projectName).toBe(
      "mailbox",
    );
  });

  it("rebuilds source ledger and search from source packages", () => {
    decideAndUpdateLedger(dir, record("The rebuildable archive mentions quarterly revenue."));
    rmSync(sourceLedgerPath(dir), { force: true });
    const result = rebuildSourceIndexFromArchive(dir);
    expect(result.packages).toBe(1);
    expect(readLedger(dir)["gmail:me:msg-1"]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(searchSourceDocuments(dir, "quarterly revenue", 5)).toHaveLength(1);
  });

  it("searches source documents through FTS", () => {
    decideAndUpdateLedger(dir, record("The board deck needs updated revenue numbers."));
    const hits = searchSourceDocuments(dir, "revenue board", 5);
    expect(hits.length).toBe(1);
    expect(hits[0]?.sourceKind).toBe("gmail");
    expect(hits[0]?.body).toContain("revenue numbers");
  });

  it("enqueues extraction jobs idempotently per extraction hash", () => {
    const first = decideAndUpdateLedger(dir, record("same body"));
    const job = enqueueSourceEnrichmentJob(dir, first.entry);
    enqueueSourceEnrichmentJob(dir, first.entry);
    expect(listSourceEnrichmentJobs(dir)).toHaveLength(1);
    expect(job.sourceDocumentKey).toBe("gmail:me:msg-1");

    const unchanged = decideAndUpdateLedger(dir, record("same body"));
    expect(unchanged.decision).toBe("unchanged");
    expect(listSourceEnrichmentJobs(dir)).toHaveLength(1);

    const updated = decideAndUpdateLedger(dir, record("new body"));
    enqueueSourceEnrichmentJob(dir, updated.entry);
    expect(listSourceEnrichmentJobs(dir)).toHaveLength(2);
  });

  it("claims, completes, and retries source enrichment jobs with backoff before failing terminally", () => {
    const { entry } = decideAndUpdateLedger(dir, record("job body"));
    enqueueSourceEnrichmentJob(dir, entry, "2026-05-14T00:00:00.000Z");
    const claimed = claimSourceEnrichmentJobs(dir, 1, "2026-05-14T00:00:00.000Z");
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.attempts).toBe(1);
    const claimedJob = claimed[0];
    if (claimedJob === undefined) throw new Error("missing claimed job");
    completeSourceEnrichmentJob(dir, claimedJob.id, "2026-05-14T00:00:01.000Z");
    expect(listSourceEnrichmentJobs(dir)[0]?.status).toBe("done");

    const updated = decideAndUpdateLedger(dir, record("job body changed"));
    const failed = enqueueSourceEnrichmentJob(dir, updated.entry, "2026-05-14T00:01:00.000Z");
    claimSourceEnrichmentJobs(dir, 1, "2026-05-14T00:01:00.000Z");
    failSourceEnrichmentJob(dir, failed.id, "boom", "2026-05-14T00:01:05.000Z");
    let failedJob = listSourceEnrichmentJobs(dir).find((j) => j.id === failed.id);
    expect(failedJob?.status).toBe("pending");
    expect(failedJob?.availableAt).toBe("2026-05-14T00:02:05.000Z");
    expect(claimSourceEnrichmentJobs(dir, 1, "2026-05-14T00:02:04.000Z")).toHaveLength(0);

    claimSourceEnrichmentJobs(dir, 1, "2026-05-14T00:02:05.000Z");
    failSourceEnrichmentJob(dir, failed.id, "still boom", "2026-05-14T00:02:06.000Z");
    failedJob = listSourceEnrichmentJobs(dir).find((j) => j.id === failed.id);
    expect(failedJob?.status).toBe("pending");
    expect(failedJob?.availableAt).toBe("2026-05-14T00:04:06.000Z");

    claimSourceEnrichmentJobs(dir, 1, "2026-05-14T00:04:06.000Z");
    failSourceEnrichmentJob(dir, failed.id, "terminal", "2026-05-14T00:04:07.000Z");
    failedJob = listSourceEnrichmentJobs(dir).find((j) => j.id === failed.id);
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.attempts).toBe(3);
    expect(failedJob?.error).toBe("terminal");
  });

  it("persists cursors and source instances in SQLite", () => {
    writeSourcesConfig(dir, {
      sources: [
        {
          id: "gmail:me",
          type: "command",
          kind: "gmail",
          command: "echo",
          schedule: "*/15 * * * *",
          mode: "pull",
        },
      ],
    });
    writeCursor(dir, "gmail:me", { historyId: "123" });
    expect(readCursor(dir, "gmail:me")).toEqual({ historyId: "123" });
    const db = new Database(sourceLedgerPath(dir));
    try {
      const row = db
        .query<{ id: string; kind: string; schedule: string }, []>(
          "SELECT id, kind, schedule FROM source_instances",
        )
        .get();
      expect(row).toEqual({ id: "gmail:me", kind: "gmail", schedule: "*/15 * * * *" });
    } finally {
      db.close();
    }
  });

  it("can mark source documents as deleted", () => {
    decideAndUpdateLedger(dir, record());
    expect(markSourceDocumentDeleted(dir, "gmail:me", "msg-1")).toBe(true);
    expect(readLedger(dir)["gmail:me:msg-1"]?.status).toBe("deleted");
  });

  it("migrates legacy JSON ledger on first open", () => {
    const sourcesDir = join(dir, "sources");
    mkdirSync(sourcesDir, { recursive: true });
    writeFileSync(
      join(sourcesDir, "ledger.json"),
      JSON.stringify({
        "legacy:one": {
          key: "legacy:one",
          sourceInstanceId: "legacy",
          sourceKind: "test",
          externalId: "one",
          rawHash: "r",
          contentHash: "c",
          firstIngestedAt: "t1",
          lastIngestedAt: "t2",
          lastSeenAt: "t3",
          status: "active",
        },
      }),
    );
    expect(readLedger(dir)["legacy:one"]?.contentHash).toBe("c");
  });
});
