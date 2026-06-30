import { describe, expect, it } from "vitest";
import { createUsageMeter, deriveModelId } from "../src/usage.ts";

describe("createUsageMeter", () => {
  it("aggregates calls per (component, modelId) pair", () => {
    const meter = createUsageMeter();
    meter.record("extractor", "openai/gpt-4o-mini", 100, 50);
    meter.record("extractor", "openai/gpt-4o-mini", 200, 75);
    meter.record("reranker", "anthropic/claude-haiku-4-5-20251001", 1500, 20);

    const snap = meter.snapshot();
    expect(snap.entries).toHaveLength(2);
    const ext = snap.entries.find((e) => e.component === "extractor");
    expect(ext).toMatchObject({
      modelId: "openai/gpt-4o-mini",
      inputTokens: 300,
      outputTokens: 125,
      calls: 2,
    });
    const rr = snap.entries.find((e) => e.component === "reranker");
    expect(rr).toMatchObject({
      inputTokens: 1500,
      outputTokens: 20,
      calls: 1,
    });
    expect(snap.totals).toEqual({ inputTokens: 1800, outputTokens: 145, calls: 3 });
  });

  it("keeps separate buckets per modelId on the same component", () => {
    const meter = createUsageMeter();
    meter.record("extractor", "openai/gpt-4o-mini", 100, 0);
    meter.record("extractor", "google/gemini-3-flash", 200, 0);
    expect(meter.snapshot().entries).toHaveLength(2);
  });

  it("returns empty totals before any record() call", () => {
    const meter = createUsageMeter();
    expect(meter.snapshot()).toEqual({
      entries: [],
      totals: { inputTokens: 0, outputTokens: 0, calls: 0 },
    });
  });
});

describe("deriveModelId", () => {
  it("returns string models verbatim", () => {
    expect(deriveModelId("openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
  });

  it("formats LanguageModel-like objects as provider/modelId", () => {
    expect(deriveModelId({ provider: "openai", modelId: "gpt-4o-mini" })).toBe(
      "openai/gpt-4o-mini",
    );
  });

  it("falls back to modelId alone when provider is missing", () => {
    expect(deriveModelId({ modelId: "gpt-4o-mini" })).toBe("gpt-4o-mini");
  });

  it("returns 'unknown' when nothing identifiable is present", () => {
    expect(deriveModelId({})).toBe("unknown");
    expect(deriveModelId(null)).toBe("unknown");
    expect(deriveModelId(undefined)).toBe("unknown");
  });
});
