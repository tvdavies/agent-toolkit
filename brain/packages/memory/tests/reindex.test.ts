import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reindexAll, reindexFile } from "../src/reindex.ts";
import { createMarkdownStore } from "../src/storage/markdown-store.ts";
import { createSqliteStorage, hashContent } from "../src/storage/sqlite.ts";

describe("hashContent", () => {
  it("is deterministic for the same input", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });

  it("differs for different inputs", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });
});

describe("reindexFile", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "reindex-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function setup() {
    const storage = createSqliteStorage();
    const markdownStore = createMarkdownStore({ rootDir });
    return { storage, markdownStore };
  }

  it("skips files that aren't in the index", async () => {
    const { storage, markdownStore } = setup();
    const w = await markdownStore.write({
      scope: "test",
      type: "facts",
      body: "User likes coffee",
      frontmatter: { id: "c1", type: "facts" },
    });
    // Index doesn't know about this file yet.
    const r = await reindexFile(w.filePath, { storage, markdownStore });
    expect(r.outcome).toBe("skipped_unindexed");
    await storage.close();
  });

  it("skips re-index when the body hash hasn't changed but refreshes derived entity/slug indexes", async () => {
    const { storage, markdownStore } = setup();
    const body = "User likes decaf";
    const w = await markdownStore.write({
      scope: "test",
      type: "preferences",
      body,
      frontmatter: { id: "c1", type: "preferences", entities: ["Coffee"] },
    });
    storage.upsertChunk({
      id: "c1",
      path: w.filePath,
      type: "preferences",
      ordinal: 0,
      content: body,
      contentHash: hashContent(body),
    });
    const r = await reindexFile(w.filePath, { storage, markdownStore });
    expect(r.outcome).toBe("skipped_unchanged");
    expect(storage.findChunksByEntities(["coffee"])).toEqual(["c1"]);
    expect(storage.resolveSlug("test", w.slug)).toBe("c1");
    await storage.close();
  });

  it("syncs the index when the body has changed on disk", async () => {
    const { storage, markdownStore } = setup();
    const oldBody = "User likes decaf";
    const w = await markdownStore.write({
      scope: "test",
      type: "preferences",
      body: oldBody,
      frontmatter: { id: "c1", type: "preferences" },
    });
    storage.upsertChunk({
      id: "c1",
      path: w.filePath,
      type: "preferences",
      ordinal: 0,
      content: oldBody,
      contentHash: hashContent(oldBody),
    });
    // Hand-edit the file on disk.
    const newBody = "User has switched to half-caf";
    const text = readFileSync(w.filePath, "utf8").replace(oldBody, newBody);
    writeFileSync(w.filePath, text);

    const r = await reindexFile(w.filePath, { storage, markdownStore });
    expect(r.outcome).toBe("synced");
    expect(r.contentHash).toBe(hashContent(newBody));

    const got = storage.getChunkByPath(w.filePath);
    expect(got?.content).toBe(newBody);
    expect(got?.contentHash).toBe(hashContent(newBody));
    // BM25 should reflect the new body.
    expect(storage.searchBM25("half-caf", 5)).toHaveLength(1);
    expect(storage.searchBM25("decaf", 5)).toHaveLength(0);
    await storage.close();
  });

  it("re-extracts edges when the body changes", async () => {
    const { storage, markdownStore } = setup();
    const oldBody = "User attended Sarah's wedding on March 15.";
    const w = await markdownStore.write({
      scope: "test",
      type: "events",
      body: oldBody,
      frontmatter: { id: "c1", type: "events", entities: ["Sarah"] },
    });
    // Seed the index but with the OLD body's hash so the first
    // reindex actually fires (the file's stored body is what
    // markdownStore wrote, which matches; we simulate "stale index"
    // by claiming a different hash here).
    storage.upsertChunk({
      id: "c1",
      path: w.filePath,
      type: "events",
      ordinal: 0,
      content: "stale-content",
      contentHash: "stale-hash",
      metadata: { entities: ["Sarah"] },
    });
    await reindexFile(w.filePath, { storage, markdownStore });
    const beforeEdges = storage.outboundEdges("c1");
    expect(beforeEdges.length).toBeGreaterThan(0);
    expect(beforeEdges.some((e) => e.toEntity === "sarah")).toBe(true);

    // Now edit the body to mention Mike too.
    const newBody = "User attended Sarah and Mike's wedding on March 15.";
    writeFileSync(w.filePath, readFileSync(w.filePath, "utf8").replace(oldBody, newBody));
    await reindexFile(w.filePath, { storage, markdownStore });

    const afterEdges = storage.outboundEdges("c1");
    expect(afterEdges.length).toBeGreaterThanOrEqual(beforeEdges.length);
    await storage.close();
  });
});

describe("reindexAll", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "reindex-all-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("walks every live chunk and reconciles", async () => {
    const storage = createSqliteStorage();
    const markdownStore = createMarkdownStore({ rootDir });
    const w1 = await markdownStore.write({
      scope: "s",
      type: "facts",
      body: "alpha body",
      frontmatter: { id: "a", type: "facts" },
    });
    const w2 = await markdownStore.write({
      scope: "s",
      type: "facts",
      body: "beta body",
      frontmatter: { id: "b", type: "facts" },
    });
    storage.upsertChunks([
      {
        id: "a",
        path: w1.filePath,
        type: "facts",
        ordinal: 0,
        content: "alpha body",
        contentHash: hashContent("alpha body"),
      },
      {
        id: "b",
        path: w2.filePath,
        type: "facts",
        ordinal: 1,
        content: "beta body",
        contentHash: hashContent("beta body"),
      },
    ]);

    // Edit one of them.
    const newAlpha = "alpha updated";
    writeFileSync(w1.filePath, readFileSync(w1.filePath, "utf8").replace("alpha body", newAlpha));

    const r = await reindexAll({ storage, markdownStore });
    expect(r.outcomes.synced).toBe(1);
    expect(r.outcomes.skipped_unchanged).toBe(1);

    expect(storage.getChunkByPath(w1.filePath)?.content).toBe(newAlpha);
    expect(storage.getChunkByPath(w2.filePath)?.content).toBe("beta body");
    await storage.close();
  });

  it("ingests orphan markdown files left by a crashed write pipeline (BRAIN-180)", async () => {
    // Simulate the crash scenario: a .md file exists on disk because
    // markdownStore.write completed, but storage.upsertChunks never
    // ran. reindexAll should pick it up and ingest it as an orphan.
    const storage = createSqliteStorage();
    const markdownStore = createMarkdownStore({ rootDir });
    const indexed = await markdownStore.write({
      scope: "s",
      type: "facts",
      body: "indexed body",
      frontmatter: { id: "a", type: "facts" },
    });
    storage.upsertChunks([
      {
        id: "a",
        path: indexed.filePath,
        type: "facts",
        ordinal: 0,
        content: "indexed body",
        contentHash: hashContent("indexed body"),
      },
    ]);
    // Orphan: written to disk, never indexed.
    const orphan = await markdownStore.write({
      scope: "s",
      type: "facts",
      body: "orphan body",
      frontmatter: { id: "orphan-fm-id", type: "facts" },
    });
    expect(storage.getChunkByPath(orphan.filePath)).toBeUndefined();

    const r = await reindexAll({ storage, markdownStore });
    expect(r.outcomes.ingested_orphan).toBe(1);
    expect(r.outcomes.skipped_unchanged).toBe(1);
    expect(r.failed).toEqual([]);

    const recovered = storage.getChunkByPath(orphan.filePath);
    expect(recovered?.content).toBe("orphan body");
    // Frontmatter id is preserved when present so the recovered
    // chunk matches its on-disk metadata.
    expect(recovered?.id).toBe("orphan-fm-id");
    expect(storage.searchBM25("orphan", 5)).toHaveLength(1);
    await storage.close();
  });

  it("mints an id when the orphan has no frontmatter id", async () => {
    const storage = createSqliteStorage();
    const markdownStore = createMarkdownStore({ rootDir });
    const orphan = await markdownStore.write({
      scope: "s",
      type: "facts",
      body: "anonymous orphan body",
      frontmatter: { type: "facts" },
    });

    const r = await reindexAll({ storage, markdownStore });
    expect(r.outcomes.ingested_orphan).toBe(1);

    const recovered = storage.getChunkByPath(orphan.filePath);
    expect(recovered?.content).toBe("anonymous orphan body");
    expect(typeof recovered?.id).toBe("string");
    expect(recovered?.id.length ?? 0).toBeGreaterThan(0);
    await storage.close();
  });

  it("ignores markdown files outside the canonical scope/type/slug shape", async () => {
    // A loose .md at the root, or in a non-type directory, should be
    // left alone — it doesn't fit the brain's layout.
    const storage = createSqliteStorage();
    const markdownStore = createMarkdownStore({ rootDir });
    writeFileSync(join(rootDir, "README.md"), "not a brain file");
    writeFileSync(join(rootDir, "stray-top-level.md"), "also not a brain file");

    const r = await reindexAll({ storage, markdownStore });
    expect(r.outcomes.ingested_orphan).toBe(0);
    expect(r.failed).toEqual([]);
    await storage.close();
  });
});
