import { describe, expect, it } from "vitest";
import { createSqliteStorage } from "../src/storage/sqlite.ts";

describe("usage counters", () => {
  it("default to zero on a fresh chunk", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunk({
        id: "a",
        path: "/tmp/a.md",
        type: "facts",
        ordinal: 0,
        content: "x",
      });
      const u = storage.getUsage("a");
      expect(u).toEqual({
        retrievalCount: 0,
        injectionCount: 0,
        citationCount: 0,
      });
    } finally {
      await storage.close();
    }
  });

  it("bump retrieval / injection / citation counters and stamp timestamps", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunk({
        id: "a",
        path: "/tmp/a.md",
        type: "facts",
        ordinal: 0,
        content: "x",
      });
      const at = 1_000_000;
      storage.bumpRetrievalCounters(["a"], at);
      storage.bumpRetrievalCounters(["a"], at + 1);
      storage.bumpInjectionCounters(["a"], at + 2);
      storage.bumpCitationCounters(["a"], at + 3);

      const u = storage.getUsage("a");
      expect(u?.retrievalCount).toBe(2);
      expect(u?.lastRetrievedAt).toBe(at + 1);
      expect(u?.injectionCount).toBe(1);
      expect(u?.lastInjectedAt).toBe(at + 2);
      expect(u?.citationCount).toBe(1);
      expect(u?.lastCitedAt).toBe(at + 3);
    } finally {
      await storage.close();
    }
  });

  it("bump is a no-op for empty id list", async () => {
    const storage = createSqliteStorage();
    try {
      expect(() => storage.bumpRetrievalCounters([])).not.toThrow();
      expect(() => storage.bumpInjectionCounters([])).not.toThrow();
      expect(() => storage.bumpCitationCounters([])).not.toThrow();
    } finally {
      await storage.close();
    }
  });

  it("getUsage returns undefined for unknown ids", async () => {
    const storage = createSqliteStorage();
    try {
      expect(storage.getUsage("nope")).toBeUndefined();
    } finally {
      await storage.close();
    }
  });
});
