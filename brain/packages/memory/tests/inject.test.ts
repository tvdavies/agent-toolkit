import type { RetrievedMemory } from "@ai-assistant/contracts";
import { describe, expect, it } from "vitest";
import { buildInjectionTrace, injectMemories } from "../src/inject.ts";
import { createSqliteStorage } from "../src/storage/sqlite.ts";

const memory = (id: string, content: string, score = 1): RetrievedMemory => ({
  id,
  content,
  source: { kind: "memory", id: `/tmp/${id}.md` },
  score,
  entities: [],
  writtenAt: new Date(0),
});

describe("buildInjectionTrace", () => {
  it("includes everything when no budget is set", () => {
    const t = buildInjectionTrace([memory("a", "alpha"), memory("b", "beta")]);
    expect(t.included).toHaveLength(2);
    expect(t.skipped).toHaveLength(0);
    expect(t.totalChars).toBe("alpha".length + "beta".length);
  });

  it("drops items past the char budget with reason char_budget", () => {
    const t = buildInjectionTrace(
      [memory("a", "x".repeat(50)), memory("b", "y".repeat(50)), memory("c", "z".repeat(50))],
      { charBudget: 75 },
    );
    expect(t.included.map((m) => m.id)).toEqual(["a"]);
    expect(t.skipped.map((s) => s.reason)).toEqual(["char_budget", "char_budget"]);
  });

  it("emits a stable injectionId shape and timestamp", () => {
    const t = buildInjectionTrace([memory("a", "x")]);
    expect(t.injectionId).toMatch(/^inj_/);
    expect(() => new Date(t.at).toISOString()).not.toThrow();
  });

  it("preserves caller source tag", () => {
    const t = buildInjectionTrace([memory("a", "x")], { source: "cli-query" });
    expect(t.source).toBe("cli-query");
  });
});

describe("injectMemories", () => {
  it("bumps injection counters for included ids only", async () => {
    const storage = createSqliteStorage();
    try {
      storage.upsertChunk({
        id: "a",
        path: "/tmp/a.md",
        type: "facts",
        ordinal: 0,
        content: "alpha",
      });
      storage.upsertChunk({
        id: "b",
        path: "/tmp/b.md",
        type: "facts",
        ordinal: 1,
        content: "beta",
      });
      const trace = injectMemories(
        storage,
        [memory("a", "alpha"), memory("b", "beta beta beta beta beta beta")],
        { charBudget: "alpha".length + 5 },
      );
      expect(trace.included.map((m) => m.id)).toEqual(["a"]);
      expect(storage.getUsage("a")?.injectionCount).toBe(1);
      expect(storage.getUsage("b")?.injectionCount).toBe(0);
    } finally {
      await storage.close();
    }
  });
});
