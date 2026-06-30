import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOurMemory } from "../src/memory.js";
import type { Writer } from "../src/write/index.js";

const entityWriter: Writer = {
  async process(_events, baseOrdinal) {
    return [
      {
        type: "facts",
        ordinal: baseOrdinal,
        content: "User met a hiking friend.",
        metadata: { entities: ["Alex from Germany"] },
      },
    ];
  },
};

describe("persistent entity index across Memory restart", () => {
  test("entity retrieval survives close/open on the same sqlite db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-restart-"));
    const dbPath = join(dir, "memory.sqlite");
    try {
      let memory = await createOurMemory({
        rootDir: dir,
        scope: "personal",
        dbPath,
        writer: entityWriter,
      });
      await memory.record({ kind: "user-turn", text: "seed" });
      await memory.flush?.();
      await memory.close?.();

      memory = await createOurMemory({
        rootDir: dir,
        scope: "personal",
        dbPath,
        writer: entityWriter,
      });
      const result = await memory.retrieve({ query: "Alex from Germany", skipEmbed: true });

      expect(result.items.map((i) => i.content)).toContain("User met a hiking friend.");
      expect(result.items[0]?.scoring?.contributions.entity).toBeDefined();
      await memory.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
