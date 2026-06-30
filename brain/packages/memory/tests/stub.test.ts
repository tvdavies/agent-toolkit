import { describe, expect, it } from "vitest";
import { StubMemory } from "../src/stub.ts";

describe("StubMemory", () => {
  it("retrieves nothing", async () => {
    const m = new StubMemory();
    const result = await m.retrieve({ query: "anything" });
    expect(result.items).toEqual([]);
    expect(result.diagnostics).toEqual({ bm25Hits: 0, vectorHits: 0, rerankerRan: false });
  });

  it("records events into its internal buffer", async () => {
    const m = new StubMemory();
    await m.record({ kind: "user-turn", text: "hi" });
    await m.record({ kind: "assistant-turn", text: "hello" });
    expect(m.snapshot()).toHaveLength(2);
    expect(m.snapshot()[0]).toEqual({ kind: "user-turn", text: "hi" });
  });

  it("accepts all MemoryEvent kinds", async () => {
    const m = new StubMemory();
    await m.record({ kind: "user-turn", text: "x" });
    await m.record({ kind: "assistant-turn", text: "y" });
    await m.record({ kind: "tool-call", tool: "t", args: {}, result: "ok" });
    await m.record({
      kind: "ingested-item",
      source: { kind: "slack", id: "1" },
      content: "z",
    });
    expect(m.snapshot()).toHaveLength(4);
  });
});
