import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultSourceStore, type SourceStore } from "../src/shared/source-store.ts";
import {
  contentForRecord,
  type IngestDecision,
  type IngestRecord,
  type SourceEnrichmentJob,
  type SourceLedgerEntry,
  type SourceSearchHit,
  type SourcesConfig,
  sourceKey,
} from "../src/shared/sources.ts";

function record(body = "The board deck mentions quarterly revenue."): IngestRecord {
  return {
    schema: "brain.ingest.v1",
    source: {
      instanceId: "gmail:test",
      kind: "gmail",
      externalId: "msg-1",
      uri: "https://mail/msg-1",
    },
    title: "Board deck",
    body,
    updatedAt: "2026-05-14T00:00:00Z",
  };
}

type StoreFactory = { name: string; create: () => SourceStore; cleanup?: () => void };

describe("SourceStore contract", () => {
  const factories: StoreFactory[] = [];
  let dirs: string[] = [];

  factories.push({
    name: "fake",
    create: () => createFakeSourceStore(),
  });

  factories.push({
    name: "default",
    create: () => {
      const dir = mkdtempSync(join(tmpdir(), "brain-source-store-"));
      dirs.push(dir);
      return createDefaultSourceStore(dir);
    },
  });

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  for (const factory of factories) {
    describe(factory.name, () => {
      it("handles create, unchanged, update, search, document read, and job lifecycle", () => {
        const store = factory.create();
        const created = store.decideAndUpdate(record());
        expect(created.decision).toBe("created");
        expect(store.decideAndUpdate(record()).decision).toBe("unchanged");
        expect(
          store.decideAndUpdate(record("The updated body mentions annual revenue.")).decision,
        ).toBe("updated");

        const hit = store.search("annual revenue", 5)[0];
        expect(hit?.sourceInstanceId).toBe("gmail:test");
        expect(hit?.body).toContain("annual revenue");

        const reread = store.readDocumentRecord("gmail:test:msg-1");
        expect(reread?.body).toContain("annual revenue");

        const ledgerEntry = store.readLedger()["gmail:test:msg-1"];
        expect(ledgerEntry).toBeDefined();
        if (ledgerEntry === undefined) throw new Error("missing test ledger entry");
        const job = store.enqueueEnrichment(ledgerEntry);
        store.enqueueEnrichment(ledgerEntry);
        expect(store.listJobs()).toHaveLength(1);
        expect(job.sourceDocumentKey).toBe("gmail:test:msg-1");

        const claimed = store.claimJobs(1);
        expect(claimed).toHaveLength(1);
        expect(claimed[0]?.attempts).toBe(1);
        const claimedJob = claimed[0];
        if (claimedJob === undefined) throw new Error("missing claimed job");
        store.completeJob(claimedJob.id);
        expect(store.listJobs()[0]?.status).toBe("done");

        const updated = store.decideAndUpdate(record("A second update mentions runway."));
        const failed = store.enqueueEnrichment(updated.entry);
        store.claimJobs(1);
        store.failJob(failed.id, "boom");
        expect(store.listJobs().find((j) => j.id === failed.id)?.error).toBe("boom");
      });
    });
  }
});

function createFakeSourceStore(): SourceStore {
  const docs = new Map<
    string,
    { record: IngestRecord; entry: SourceLedgerEntry; extractionHash: string }
  >();
  const jobs = new Map<string, SourceEnrichmentJob>();
  let cfg: SourcesConfig = { sources: [] };
  const cursors = new Map<string, unknown>();

  return {
    decideAndUpdate(record) {
      const key = sourceKey(record);
      const contentHash = hash(contentForRecord(record));
      const extractionHash = hash(
        JSON.stringify({
          title: record.title,
          body: record.body,
          refs: record.refs,
          thread: record.thread,
        }),
      );
      const existing = docs.get(key);
      const now = new Date().toISOString();
      const decision: IngestDecision =
        existing === undefined
          ? "created"
          : existing.entry.contentHash === contentHash
            ? "unchanged"
            : "updated";
      const entry: SourceLedgerEntry = {
        key,
        sourceInstanceId: record.source.instanceId,
        sourceKind: record.source.kind,
        externalId: record.source.externalId,
        ...(record.source.uri !== undefined ? { uri: record.source.uri } : {}),
        ...(record.title !== undefined ? { title: record.title } : {}),
        rawHash: hash(JSON.stringify(record)),
        contentHash,
        firstIngestedAt: existing?.entry.firstIngestedAt ?? now,
        lastIngestedAt: now,
        lastSeenAt: now,
        ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
        status: "active",
      };
      docs.set(key, { record, entry, extractionHash });
      return { decision, entry };
    },
    readLedger: () => Object.fromEntries([...docs].map(([key, value]) => [key, value.entry])),
    search(query, limit = 10) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits: SourceSearchHit[] = [];
      for (const [key, { record }] of docs) {
        const haystack = `${record.title ?? ""} ${record.body}`.toLowerCase();
        if (terms.some((term) => haystack.includes(term))) {
          hits.push({
            key,
            sourceInstanceId: record.source.instanceId,
            sourceKind: record.source.kind,
            externalId: record.source.externalId,
            ...(record.title ? { title: record.title } : {}),
            body: record.body,
            ...(record.source.uri ? { uri: record.source.uri } : {}),
            ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
            score: 1,
          });
        }
      }
      return hits.slice(0, limit);
    },
    enqueueEnrichment(entry) {
      const extractionHash = docs.get(entry.key)?.extractionHash ?? entry.contentHash;
      const id = `extract-source-doc:${entry.key}:${extractionHash}`;
      const now = new Date().toISOString();
      const existing = jobs.get(id);
      if (existing && existing.status === "done") return existing;
      const job: SourceEnrichmentJob = existing ?? {
        id,
        type: "extract-source-doc",
        sourceDocumentKey: entry.key,
        contentHash: entry.contentHash,
        extractionHash,
        status: "pending",
        priority: 0,
        attempts: 0,
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      };
      jobs.set(id, {
        ...job,
        status: existing?.status === "done" ? "done" : "pending",
        updatedAt: now,
      });
      const stored = jobs.get(id);
      if (stored === undefined) throw new Error(`missing fake job: ${id}`);
      return stored;
    },
    listJobs: (limit = 50) => [...jobs.values()].slice(0, limit),
    claimJobs(limit = 10) {
      const claimed: SourceEnrichmentJob[] = [];
      for (const job of jobs.values()) {
        if (claimed.length >= limit) break;
        if (job.status === "pending") {
          job.status = "running";
          job.attempts++;
          claimed.push({ ...job });
        }
      }
      return claimed;
    },
    completeJob(id) {
      const job = jobs.get(id);
      if (job) {
        job.status = "done";
        delete job.error;
      }
    },
    failJob(id, error) {
      const job = jobs.get(id);
      if (job) {
        job.status = "failed";
        job.error = error;
      }
    },
    readDocumentRecord: (key) => docs.get(key)?.record,
    markDeleted(sourceInstanceId, externalId) {
      const doc = docs.get(`${sourceInstanceId}:${externalId}`);
      if (!doc) return false;
      doc.entry.status = "deleted";
      return true;
    },
    rebuildFromArchive: () => ({ packages: docs.size }),
    readSourcesConfig: () => cfg,
    writeSourcesConfig: (config) => {
      cfg = config;
    },
    readCursor: (id) => cursors.get(id),
    writeCursor: (id, cursor) => {
      cursors.set(id, cursor);
    },
    runCommandConnector: async () => "",
  };
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
