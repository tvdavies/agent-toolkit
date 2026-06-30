import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOurMemory } from "../src/memory.js";
import type { Writer } from "../src/write/index.js";

describe("supersedes metadata", () => {
  test("new chunks mark old chunks as superseded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supersedes-"));
    let oldId = "";
    const writer: Writer = {
      async process(_events, baseOrdinal) {
        if (baseOrdinal === 0) {
          return [{ id: "old", type: "preferences", ordinal: 0, content: "User likes coffee." }];
        }
        return [
          {
            id: "new",
            type: "preferences",
            ordinal: baseOrdinal,
            content: "User prefers decaf coffee.",
            metadata: { supersedes: oldId },
          },
        ];
      },
    };
    try {
      const memory = await createOurMemory({ rootDir: dir, scope: "personal", writer });
      await memory.record({ kind: "user-turn", text: "I like coffee" });
      await memory.flush?.();
      oldId = "old";
      await memory.record({ kind: "user-turn", text: "I prefer decaf coffee now" });
      await memory.flush?.();
      const result = await memory.retrieve({
        query: "coffee",
        skipEmbed: true,
        budget: { maxItems: 5 },
      });
      const old = result.items.find((i) => i.id === "old");
      expect(old?.scoring?.statusMultiplier).toBeLessThan(1);
      await memory.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
