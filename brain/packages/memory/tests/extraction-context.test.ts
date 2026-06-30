import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOurMemory } from "../src/memory.js";
import type { WriteContext, Writer } from "../src/write/index.js";

function captureWriter(captures: WriteContext[]): Writer {
  return {
    async process(_events, baseOrdinal, context) {
      captures.push(context ?? {});
      return [
        {
          type: "facts",
          ordinal: baseOrdinal,
          content: `User likes coffee ${captures.length}`,
        },
      ];
    },
  };
}

describe("existing-memory write context", () => {
  test("writer receives relevant existing memory previews on later flushes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "existing-context-"));
    const captures: WriteContext[] = [];
    try {
      const memory = await createOurMemory({
        rootDir: dir,
        scope: "personal",
        writer: captureWriter(captures),
      });

      await memory.record({ kind: "user-turn", text: "I like coffee" });
      await memory.flush?.();
      await memory.record({ kind: "user-turn", text: "Actually I now prefer decaf coffee" });
      await memory.flush?.();

      expect(captures[0]?.existingMemories ?? []).toHaveLength(0);
      expect(captures[1]?.existingMemories?.[0]?.content).toContain("coffee");
      await memory.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
