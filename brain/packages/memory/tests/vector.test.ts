import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOurMemory } from "../src/memory.ts";
import { createSqliteStorage } from "../src/storage/sqlite.ts";

const DIM = 4;

function unit(values: number[]): Float32Array {
  const v = new Float32Array(values);
  let n = 0;
  for (const x of v) n += x * x;
  const len = Math.sqrt(n);
  if (len === 0) return v;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    v[i] = x / len;
  }
  return v;
}

describe("storage: vector path", () => {
  it("round-trips embeddings and ranks by similarity", async () => {
    const storage = createSqliteStorage({ vectorDim: DIM });
    try {
      storage.upsertChunk({
        id: "a",
        path: "p",
        type: "facts",
        ordinal: 0,
        content: "alpha",
        embedding: unit([1, 0, 0, 0]),
      });
      storage.upsertChunk({
        id: "b",
        path: "p",
        type: "facts",
        ordinal: 1,
        content: "beta",
        embedding: unit([0, 1, 0, 0]),
      });
      storage.upsertChunk({
        id: "c",
        path: "p",
        type: "facts",
        ordinal: 2,
        content: "gamma",
        embedding: unit([0, 0, 1, 0]),
      });

      const hits = storage.searchVector(unit([0.9, 0.1, 0, 0]), 3);
      expect(hits.length).toBe(3);
      const [first, second, third] = hits;
      if (!first || !second || !third) throw new Error("expected three hits");
      expect(first.chunk.id).toBe("a");
      expect(first.score).toBeGreaterThanOrEqual(second.score);
      expect(second.score).toBeGreaterThanOrEqual(third.score);
      expect(first.score).toBeGreaterThan(third.score);
    } finally {
      await storage.close();
    }
  });

  it("rejects mismatched query embedding dim", async () => {
    const storage = createSqliteStorage({ vectorDim: DIM });
    try {
      expect(() => storage.searchVector(new Float32Array(8), 3)).toThrow(/dim mismatch/);
    } finally {
      await storage.close();
    }
  });

  it("rejects mismatched stored embedding dim", async () => {
    const storage = createSqliteStorage({ vectorDim: DIM });
    try {
      expect(() =>
        storage.upsertChunk({
          id: "a",
          path: "p",
          type: "facts",
          ordinal: 0,
          content: "x",
          embedding: new Float32Array(2),
        }),
      ).toThrow(/dim mismatch/);
    } finally {
      await storage.close();
    }
  });

  it("chunks without embeddings are not vector-searchable", async () => {
    const storage = createSqliteStorage({ vectorDim: DIM });
    try {
      storage.upsertChunk({ id: "a", path: "p", type: "facts", ordinal: 0, content: "alpha" });
      const hits = storage.searchVector(unit([1, 0, 0, 0]), 3);
      expect(hits).toEqual([]);
      expect(storage.searchBM25("alpha", 3).length).toBe(1);
    } finally {
      await storage.close();
    }
  });
});

describe("memory: hybrid path with stub embedder", () => {
  let rootDir: string;
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "memory-vec-"));
  });
  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });
  const opts = () => ({ rootDir, scope: "test" });

  it("retrieves via BM25 + vector fused by RRF", async () => {
    let counter = 0;
    const stubEmbedder = {
      id: "stub",
      dim: DIM,
      async embed(texts: readonly string[]) {
        return texts.map((t) => {
          counter++;
          const c = t.toLowerCase().match(/[a-z]/)?.[0] ?? "z";
          const code = c.charCodeAt(0) - 97;
          const base = [0, 0, 0, 0];
          base[code % DIM] = 1;
          return unit(base);
        });
      },
    };

    const memory = await createOurMemory({ ...opts(), embedder: stubEmbedder });
    try {
      await memory.record({
        kind: "ingested-item",
        source: { kind: "test", id: "1" },
        content: "alpha and bravo",
      });
      await memory.record({
        kind: "ingested-item",
        source: { kind: "test", id: "2" },
        content: "charlie won the race",
      });
      await memory.record({
        kind: "ingested-item",
        source: { kind: "test", id: "3" },
        content: "delta force ready",
      });

      const r = await memory.retrieve({ query: "alpha", budget: { maxItems: 3 } });
      expect(r.diagnostics?.vectorHits).toBeGreaterThan(0);
      expect(r.diagnostics?.bm25Hits).toBeGreaterThan(0);
      expect(r.items.length).toBeGreaterThan(0);
      const top = r.items[0];
      if (!top) throw new Error("expected at least one item");
      expect(top.content).toContain("alpha");
      expect(counter).toBeGreaterThan(0);
    } finally {
      await memory.close?.();
    }
  });

  it("falls back to BM25 only when there's no embedder", async () => {
    const memory = await createOurMemory(opts());
    try {
      await memory.record({ kind: "user-turn", text: "alpha bravo" });
      const r = await memory.retrieve({ query: "alpha", budget: { maxItems: 3 } });
      expect(r.diagnostics?.vectorHits).toBe(0);
      expect(r.diagnostics?.bm25Hits).toBeGreaterThan(0);
    } finally {
      await memory.close?.();
    }
  });
});
