import { describe, expect, it } from "vitest";
import {
  applyCosineRescore,
  COSINE_RESCORE_COSINE_WEIGHT,
  COSINE_RESCORE_RRF_WEIGHT,
} from "../src/retrieval/cosine-rescore.ts";

describe("applyCosineRescore", () => {
  it("blends rrf + cosine for hits with a vector contribution", () => {
    const hits = [{ score: 0.5, contributions: { vector: 0.9 } }];
    applyCosineRescore(hits);
    const expected = COSINE_RESCORE_RRF_WEIGHT * 0.5 + COSINE_RESCORE_COSINE_WEIGHT * 0.9;
    expect(hits[0]?.score).toBeCloseTo(expected, 6);
  });

  it("preserves relative ordering for keyword-only hits (no vector contribution)", () => {
    const hits = [
      { score: 0.8, contributions: {} },
      { score: 0.6, contributions: {} },
      { score: 0.4, contributions: {} },
    ];
    applyCosineRescore(hits);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
    expect(hits[1]?.score).toBeGreaterThan(hits[2]?.score ?? 0);
  });

  it("clamps negative cosine values to zero", () => {
    const hits = [{ score: 0.5, contributions: { vector: -0.2 } }];
    applyCosineRescore(hits);
    expect(hits[0]?.score).toBeCloseTo(COSINE_RESCORE_RRF_WEIGHT * 0.5, 6);
  });

  it("flips ranking when a low-RRF candidate has very high cosine", () => {
    const a = { score: 0.6, contributions: { vector: 0.0 } };
    const b = { score: 0.5, contributions: { vector: 1.0 } };
    applyCosineRescore([a, b]);
    expect(b.score).toBeGreaterThan(a.score);
  });
});
