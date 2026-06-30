import { describe, expect, it } from "vitest";
import {
  applyBacklinkBoost,
  applyBacklinkBoostFor,
  BACKLINK_BOOST_COEF,
} from "../src/retrieval/backlink-boost.ts";

describe("applyBacklinkBoostFor", () => {
  it("is a no-op for zero counts", () => {
    const hit = { score: 1 };
    applyBacklinkBoostFor(hit, 0);
    expect(hit.score).toBe(1);
  });

  it("boosts proportional to log(1 + count)", () => {
    const hit = { score: 1 };
    applyBacklinkBoostFor(hit, 10);
    const expected = 1 + BACKLINK_BOOST_COEF * Math.log(1 + 10);
    expect(hit.score).toBeCloseTo(expected, 6);
  });

  it("boost grows with count but saturates logarithmically", () => {
    const a = { score: 1 };
    const b = { score: 1 };
    applyBacklinkBoostFor(a, 1);
    applyBacklinkBoostFor(b, 100);
    expect(b.score).toBeGreaterThan(a.score);
    // 100x more backlinks should NOT mean 100x boost — log scaling.
    expect(b.score / a.score).toBeLessThan(10);
  });
});

describe("applyBacklinkBoost", () => {
  it("scales every hit by its own count", () => {
    const hits = [
      { score: 1, id: "a" },
      { score: 1, id: "b" },
    ];
    const counts = new Map([
      ["a", 0],
      ["b", 50],
    ]);
    applyBacklinkBoost(hits, (h) => counts.get(h.id) ?? 0);
    expect(hits[0]?.score).toBe(1);
    expect(hits[1]?.score).toBeGreaterThan(1);
  });
});
