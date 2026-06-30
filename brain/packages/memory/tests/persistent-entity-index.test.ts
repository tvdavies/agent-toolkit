import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "../src/storage/sqlite.js";

describe("persistent entity and slug indexes", () => {
  test("entity links survive storage reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "entity-index-"));
    const dbPath = join(dir, "memory.sqlite");
    try {
      let storage = createSqliteStorage({ dbPath });
      storage.upsertChunk({
        id: "c1",
        path: "/tmp/events/alex-from-germany.md",
        type: "events",
        ordinal: 1,
        content: "User met Alex.",
      });
      storage.upsertChunkEntities("c1", ["Alex from Germany"]);
      await storage.close();

      storage = createSqliteStorage({ dbPath });
      expect(storage.findChunksByEntities(["alex from germany"])).toEqual(["c1"]);
      expect(storage.findChunksByEntities(["alex"])).toEqual(["c1"]);
      await storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("slug resolver survives storage reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slug-index-"));
    const dbPath = join(dir, "memory.sqlite");
    try {
      let storage = createSqliteStorage({ dbPath });
      storage.upsertChunk({
        id: "c1",
        path: "/tmp/facts/favourite-coffee.md",
        type: "facts",
        ordinal: 1,
        content: "User likes espresso.",
      });
      storage.upsertSlug("personal", "favourite-coffee", "c1");
      await storage.close();

      storage = createSqliteStorage({ dbPath });
      expect(storage.resolveSlug("personal", "favourite-coffee")).toBe("c1");
      await storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
