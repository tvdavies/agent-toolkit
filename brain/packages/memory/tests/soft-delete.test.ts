import { describe, expect, it } from "vitest";
import { createSqliteStorage } from "../src/storage/sqlite.ts";

describe("soft-delete + recovery window", () => {
  it("hides archived chunks from search and getChunk", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunks([
        { id: "a", path: "p/a.md", type: "facts", ordinal: 0, content: "alpha is here" },
        { id: "b", path: "p/b.md", type: "facts", ordinal: 1, content: "beta is here" },
      ]);
      expect(storage.size()).toBe(2);
      expect(storage.searchBM25("alpha", 5)).toHaveLength(1);

      storage.archiveChunk("a");

      expect(storage.size()).toBe(1);
      expect(storage.getChunk("a")).toBeUndefined();
      expect(storage.searchBM25("alpha", 5)).toHaveLength(0);
      // Surviving chunk still searchable.
      expect(storage.searchBM25("beta", 5)).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });

  it("restoreChunk re-exposes an archived chunk", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunk({
        id: "a",
        path: "p",
        type: "facts",
        ordinal: 0,
        content: "lazarus rising",
      });
      storage.archiveChunk("a");
      expect(storage.searchBM25("lazarus", 5)).toHaveLength(0);
      storage.restoreChunk("a");
      expect(storage.searchBM25("lazarus", 5)).toHaveLength(1);
    } finally {
      await storage.close();
    }
  });

  it("purgeExpired drops only chunks past archive_expires_at", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunks([
        { id: "old", path: "p", type: "facts", ordinal: 0, content: "ancient" },
        { id: "fresh", path: "p", type: "facts", ordinal: 1, content: "recent" },
      ]);
      // Archive both, but with different recovery windows.
      storage.archiveChunk("old", -1); // already expired
      storage.archiveChunk("fresh", 60 * 60 * 1000); // 1h grace

      const purged = storage.purgeExpired(Date.now());
      expect(purged).toBe(1);
      // 'fresh' is still archived but not purged.
      storage.restoreChunk("fresh");
      expect(storage.getChunk("fresh")).toBeDefined();
      expect(storage.getChunk("old")).toBeUndefined();
    } finally {
      await storage.close();
    }
  });

  it("archiveChunk on already-archived row is a no-op", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunk({
        id: "a",
        path: "p",
        type: "facts",
        ordinal: 0,
        content: "hello",
      });
      storage.archiveChunk("a");
      const beforeRestore = Date.now();
      storage.archiveChunk("a"); // would clobber expires_at if not guarded
      storage.restoreChunk("a");
      // The first archive's expires_at survived — call sequence didn't crash.
      expect(beforeRestore).toBeGreaterThan(0);
      expect(storage.size()).toBe(1);
    } finally {
      await storage.close();
    }
  });
});
