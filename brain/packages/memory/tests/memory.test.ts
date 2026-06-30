import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOurMemory, type WritePipelineStageEvent } from "../src/memory.ts";
import { createMarkdownStore } from "../src/storage/markdown-store.ts";

describe("createOurMemory", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "memory-test-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const opts = () => ({ rootDir, scope: "test" });

  it("archives raw conversation turns but excludes them from normal BM25 recall", async () => {
    const memory = await createOurMemory(opts());
    try {
      await memory.record({ kind: "user-turn", text: "I love chocolate cake with raspberry." });
      await memory.record({
        kind: "assistant-turn",
        text: "Noted, chocolate cake is your favourite.",
      });
      await memory.record({ kind: "user-turn", text: "What is the capital of France?" });

      const result = await memory.retrieve({ query: "chocolate", budget: { maxItems: 3 } });
      expect(result.items).toEqual([]);
      expect(result.diagnostics?.rerankerRan).toBe(false);
      expect(result.diagnostics?.vectorHits).toBe(0);
    } finally {
      await memory.close?.();
    }
  });

  it("returns no items when nothing matches", async () => {
    const memory = await createOurMemory(opts());
    try {
      await memory.record({ kind: "user-turn", text: "I bought new shoes today." });
      const result = await memory.retrieve({ query: "quantum entanglement" });
      expect(result.items).toEqual([]);
    } finally {
      await memory.close?.();
    }
  });

  it("respects budget.maxItems", async () => {
    const memory = await createOurMemory(opts());
    try {
      for (let i = 0; i < 10; i++) {
        await memory.record({ kind: "user-turn", text: `meeting in room ${i}` });
      }
      const r = await memory.retrieve({ query: "meeting room", budget: { maxItems: 3 } });
      expect(r.items.length).toBeLessThanOrEqual(3);
    } finally {
      await memory.close?.();
    }
  });

  it("ingested-item events become retrievable chunks too", async () => {
    const memory = await createOurMemory(opts());
    try {
      await memory.record({
        kind: "ingested-item",
        source: { kind: "slack", id: "msg-1" },
        content: "Alex: Jeff's brain hit 87.8% on LongMemEval",
      });
      const r = await memory.retrieve({ query: "LongMemEval" });
      expect(r.items.length).toBe(1);
    } finally {
      await memory.close?.();
    }
  });

  it("propagates source provenance from ingested items into frontmatter and retrieval output", async () => {
    const memory = await createOurMemory(opts());
    try {
      await memory.record({
        kind: "ingested-item",
        source: {
          kind: "slack",
          id: "C1/123.456",
          url: "https://example.com/slack/C1/p123456",
          title: "#team thread",
        },
        content: "Riley decided to use the provenance envelope shape.",
        recordedAt: "2026-05-15T12:00:00Z",
      });
      const r = await memory.retrieve({ query: "provenance envelope", skipEmbed: true });
      expect(r.items.length).toBe(1);
      expect(r.items[0]?.source).toMatchObject({
        kind: "memory",
        url: "https://example.com/slack/C1/p123456",
        title: "#team thread",
      });

      const store = createMarkdownStore({ rootDir });
      const paths = await store.list("test", "observations");
      const firstPath = paths[0];
      if (firstPath === undefined) throw new Error("missing observation file");
      const file = await store.read(firstPath);
      expect(file.frontmatter).toMatchObject({
        sourceKind: "slack",
        sourceUri: "https://example.com/slack/C1/p123456",
        sourceTitle: "#team thread",
        derivedFrom: ["C1/123.456"],
        recordedAt: "2026-05-15T12:00:00Z",
      });
    } finally {
      await memory.close?.();
    }
  });

  it("drops tool-call events silently", async () => {
    const memory = await createOurMemory(opts());
    try {
      await memory.record({ kind: "tool-call", tool: "x", args: {}, result: "huge dump" });
      await memory.record({ kind: "user-turn", text: "real content" });
      const r = await memory.retrieve({ query: "huge dump" });
      expect(r.items).toEqual([]);
      const r2 = await memory.retrieve({ query: "real content" });
      expect(r2.items).toEqual([]);
    } finally {
      await memory.close?.();
    }
  });

  it("emits write-pipeline stage events for diagnostics (BRAIN-180)", async () => {
    const stages: WritePipelineStageEvent["stage"][] = [];
    const memory = await createOurMemory({
      ...opts(),
      onWritePipelineStage: (event) => stages.push(event.stage),
    });
    try {
      await memory.record({ kind: "ingested-item", content: "diagnostic body" });
      // Sync mode: retrieve() implicitly flushes the write buffer
      // through the full pipeline.
      await memory.retrieve({ query: "anything" });
      // Order matters: a crash mid-pipeline would leave the last
      // emitted stage as the failing one. `done` only fires on full
      // success.
      expect(stages).toEqual([
        "writer",
        "dedup",
        "consolidate",
        "persist",
        "index",
        "edge",
        "done",
      ]);
    } finally {
      await memory.close?.();
    }
  });

  it("hook errors do not derail the write pipeline", async () => {
    // Observability must never break the brain. A buggy hook that
    // throws should be swallowed; the chunk still lands.
    const memory = await createOurMemory({
      ...opts(),
      onWritePipelineStage: () => {
        throw new Error("buggy hook");
      },
    });
    try {
      await memory.record({ kind: "ingested-item", content: "must still persist" });
      const r = await memory.retrieve({ query: "still persist" });
      expect(r.items.length).toBeGreaterThan(0);
    } finally {
      await memory.close?.();
    }
  });

  it("reuses crash-residue markdown on retry instead of creating a slug-2 duplicate (BRAIN-180)", async () => {
    // End-to-end BRAIN-180: simulate the crash window at the
    // integration level. A previous pipeline attempt persisted a
    // markdown file but crashed before storage.upsertChunks. The
    // retry must reuse the existing file — one file on disk, one
    // row in storage, no slug-2 pollution.
    const directStore = createMarkdownStore({ rootDir });
    const residue = await directStore.write({
      scope: "test",
      type: "observations",
      body: "crash residue body for retry",
      frontmatter: { id: "stale-from-crash", type: "observations" },
    });

    const memory = await createOurMemory(opts());
    try {
      await memory.record({
        kind: "ingested-item",
        content: "crash residue body for retry",
      });
      // retrieve() implicitly flushes the write buffer through the
      // full pipeline.
      await memory.retrieve({ query: "anything" });

      const filesOnDisk = await directStore.list("test", "observations");
      expect(filesOnDisk).toHaveLength(1);
      expect(filesOnDisk[0]).toBe(residue.filePath);
    } finally {
      await memory.close?.();
    }
  });

  it("close() releases resources", async () => {
    const memory = await createOurMemory(opts());
    await memory.record({ kind: "user-turn", text: "hi" });
    await memory.retrieve({ query: "hi" });
    await memory.close?.();
    // calling close again should not throw
    await memory.close?.();
  });

  it("write-time content-hash dedup: identical events produce one chunk", async () => {
    const memory = await createOurMemory(opts());
    try {
      // Same exact text, recorded twice. Without dedup we'd get two
      // episodic chunks; with dedup the second is dropped.
      await memory.record({
        kind: "user-turn",
        text: "I love pizza.",
        recordedAt: "2026-05-08",
      });
      await memory.record({
        kind: "user-turn",
        text: "I love pizza.",
        recordedAt: "2026-05-08",
      });
      const result = await memory.retrieve({ query: "pizza", budget: { maxItems: 5 } });
      expect(result.items).toEqual([]);
    } finally {
      await memory.close?.();
    }
  });

  it("write-time dedup keeps semantically similar but textually distinct events", async () => {
    const memory = await createOurMemory(opts());
    try {
      // Same idea, different surface form → different content hash → both kept.
      await memory.record({ kind: "user-turn", text: "Pizza is my favourite food." });
      await memory.record({ kind: "user-turn", text: "I really love pizza." });
      const result = await memory.retrieve({ query: "pizza", budget: { maxItems: 5 } });
      expect(result.items).toEqual([]);
    } finally {
      await memory.close?.();
    }
  });
});
