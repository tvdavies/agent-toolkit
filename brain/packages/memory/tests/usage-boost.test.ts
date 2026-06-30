import { describe, expect, test } from "bun:test";
import { applyUsageBoost } from "../src/retrieval/usage-boost.js";

describe("applyUsageBoost", () => {
  test("boosts cited memories more than merely retrieved memories", () => {
    const retrieved = { score: 1 };
    const cited = { score: 1 };

    const r = applyUsageBoost(retrieved, {
      retrievalCount: 10,
      injectionCount: 0,
      citationCount: 0,
    });
    const c = applyUsageBoost(cited, {
      retrievalCount: 0,
      injectionCount: 0,
      citationCount: 3,
    });

    expect(c).toBeGreaterThan(r);
    expect(cited.score).toBeGreaterThan(retrieved.score);
  });

  test("softly penalises unused low-confidence memories", () => {
    const hit = { score: 1, metadata: { confidence: "low" } };
    const multiplier = applyUsageBoost(hit, undefined);
    expect(multiplier).toBeLessThan(1);
    expect(hit.score).toBe(0.9);
  });
});
