import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOurMemory } from "../src/memory.js";

describe("retrieval impression log", () => {
  test("retrieve appends a jsonl impression", async () => {
    const dir = mkdtempSync(join(tmpdir(), "retrieval-log-"));
    try {
      const memory = await createOurMemory({ rootDir: dir, scope: "personal" });
      await memory.record({
        kind: "ingested-item",
        source: { kind: "test", id: "coffee" },
        content: "User likes coffee",
      });
      await memory.retrieve({ query: "coffee AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY" });
      const cacheDir = join(dir, ".cache");
      const log = join(cacheDir, "personal.retrievals.jsonl");
      expect(existsSync(log)).toBe(true);
      const row = JSON.parse(readFileSync(log, "utf8").trim());
      expect(row.query).toContain("coffee");
      expect(row.query).toContain("[REDACTED]");
      expect(row.query).not.toContain("wJalrXUtnFEMIK7MDENGbPxRfiCY");
      expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
      expect(statSync(log).mode & 0o777).toBe(0o600);
      expect(row.itemIds.length).toBeGreaterThan(0);
      await memory.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
