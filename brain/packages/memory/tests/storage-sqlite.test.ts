import { describe, expect, it } from "vitest";
import { createSqliteStorage, sanitiseFts5Query } from "../src/storage/sqlite.ts";

describe("createSqliteStorage", () => {
  it("upserts a single chunk and retrieves it by id", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunk({
        id: "c1",
        path: "/tmp/m/c1.md",
        type: "episodic",
        ordinal: 1,
        content: "the cat sat on the mat",
      });
      const got = storage.getChunk("c1");
      expect(got).toBeDefined();
      expect(got?.content).toBe("the cat sat on the mat");
      expect(storage.size()).toBe(1);
    } finally {
      await storage.close();
    }
  });

  it("upsert is idempotent on the same id (replace, not duplicate)", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunk({ id: "c1", path: "p", type: "facts", ordinal: 0, content: "first" });
      storage.upsertChunk({ id: "c1", path: "p", type: "facts", ordinal: 0, content: "second" });
      expect(storage.size()).toBe(1);
      expect(storage.getChunk("c1")?.content).toBe("second");
    } finally {
      await storage.close();
    }
  });

  it("delete removes from chunks and FTS", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunk({
        id: "c1",
        path: "p",
        type: "facts",
        ordinal: 0,
        content: "lonely chunk",
      });
      expect(storage.size()).toBe(1);
      storage.deleteChunk("c1");
      expect(storage.size()).toBe(0);
      expect(storage.searchBM25("lonely", 5)).toEqual([]);
    } finally {
      await storage.close();
    }
  });

  it("BM25 ranks matches over non-matches", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunks([
        { id: "a", path: "p", type: "facts", ordinal: 0, content: "I love chocolate cake" },
        { id: "b", path: "p", type: "facts", ordinal: 1, content: "the weather is sunny today" },
        { id: "c", path: "p", type: "facts", ordinal: 2, content: "chocolate is my favourite" },
      ]);
      const hits = storage.searchBM25("chocolate", 5);
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expect(hits.every((h) => h.chunk.content.toLowerCase().includes("chocolate"))).toBe(true);
      expect(hits[0]?.score).toBeGreaterThanOrEqual(hits[1]?.score ?? -Infinity);
    } finally {
      await storage.close();
    }
  });

  it("returns empty for queries with no usable tokens", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunk({ id: "c1", path: "p", type: "facts", ordinal: 0, content: "hello" });
      expect(storage.searchBM25("...", 5)).toEqual([]);
      expect(storage.searchBM25("", 5)).toEqual([]);
    } finally {
      await storage.close();
    }
  });

  it("survives raw user queries with apostrophes and FTS5 reserved words", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunk({
        id: "c1",
        path: "p",
        type: "facts",
        ordinal: 0,
        content: "I picked up the package yesterday",
      });
      // Each of these would crash a raw FTS5 MATCH; sanitisation makes them safe.
      const tricky = [
        "what's the package status?",
        "did I pick up the package on time.",
        "find related items up to today",
      ];
      for (const q of tricky) {
        const hits = storage.searchBM25(q, 5);
        expect(hits.length).toBeGreaterThan(0);
      }
    } finally {
      await storage.close();
    }
  });
});

describe("sanitiseFts5Query", () => {
  it("strips punctuation and symbols", () => {
    expect(sanitiseFts5Query("what's up?")).toBe("what s up");
    expect(sanitiseFts5Query("foo.bar:baz")).toBe("foo bar baz");
    expect(sanitiseFts5Query("(hello) [world]!")).toBe("hello world");
  });

  it("collapses whitespace", () => {
    expect(sanitiseFts5Query("  multiple   spaces\n\there  ")).toBe("multiple spaces here");
  });

  it("preserves unicode letters and numbers", () => {
    expect(sanitiseFts5Query("café 123")).toBe("café 123");
    expect(sanitiseFts5Query("北京 weather")).toBe("北京 weather");
  });

  it("returns empty string for queries with only punctuation", () => {
    expect(sanitiseFts5Query("...!?")).toBe("");
    expect(sanitiseFts5Query("")).toBe("");
  });
});
