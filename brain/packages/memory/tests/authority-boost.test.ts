import { describe, expect, it } from "vitest";
import {
  AUTHORITY_LEVELS,
  applyAuthorityBoost,
  authorityMultiplier,
  coerceAuthority,
  DEFAULT_AUTHORITY,
} from "../src/retrieval/authority-boost.ts";

describe("coerceAuthority", () => {
  it("accepts every canonical authority value", () => {
    for (const a of AUTHORITY_LEVELS) {
      expect(coerceAuthority(a)).toBe(a);
    }
  });

  it("falls back to extracted on unknown values", () => {
    expect(coerceAuthority("nonsense")).toBe(DEFAULT_AUTHORITY);
    expect(coerceAuthority(undefined)).toBe(DEFAULT_AUTHORITY);
    expect(coerceAuthority(42)).toBe(DEFAULT_AUTHORITY);
  });
});

describe("authorityMultiplier", () => {
  it("ranks pinned > manual > observed > extracted > inferred > consolidated", () => {
    expect(authorityMultiplier("pinned")).toBeGreaterThan(authorityMultiplier("manual"));
    expect(authorityMultiplier("manual")).toBeGreaterThan(authorityMultiplier("observed"));
    expect(authorityMultiplier("observed")).toBeGreaterThan(authorityMultiplier("extracted"));
    expect(authorityMultiplier("extracted")).toBeGreaterThan(authorityMultiplier("inferred"));
    expect(authorityMultiplier("inferred")).toBeGreaterThan(authorityMultiplier("consolidated"));
  });

  it("default extracted is 1.0 — no penalty for legacy chunks", () => {
    expect(authorityMultiplier("extracted")).toBe(1.0);
  });
});

describe("applyAuthorityBoost", () => {
  it("multiplies score in place per the chunk's authority", () => {
    const hits = [
      { score: 1, metadata: { authority: "pinned" } },
      { score: 1, metadata: { authority: "extracted" } },
      { score: 1, metadata: { authority: "consolidated" } },
    ];
    const ms = applyAuthorityBoost(hits);
    expect(ms).toEqual([3.0, 1.0, 0.7]);
    expect(hits[0]?.score).toBe(3);
    expect(hits[1]?.score).toBe(1);
    expect(hits[2]?.score).toBeCloseTo(0.7, 6);
  });

  it("falls back to extracted when authority is missing", () => {
    const hit = { score: 2 };
    expect(applyAuthorityBoost([hit])).toEqual([1.0]);
    expect(hit.score).toBe(2);
  });

  it("flips ranking — pinned manual edit beats high-score extracted", () => {
    const a = { score: 0.5, metadata: { authority: "pinned" } };
    const b = { score: 1.0, metadata: { authority: "extracted" } };
    applyAuthorityBoost([a, b]);
    expect(a.score).toBeGreaterThan(b.score);
  });
});
