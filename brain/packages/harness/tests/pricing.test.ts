import { describe, expect, it } from "vitest";
import { priceOf } from "../src/pricing.ts";

describe("priceOf", () => {
  it("computes blended cost from per-1M rates", () => {
    // Haiku 4.5: $1/M in, $5/M out. 1000 in + 500 out = $0.001 + $0.0025 = $0.0035
    expect(priceOf("claude-haiku-4-5-20251001", 1000, 500)).toBeCloseTo(0.0035, 6);
  });

  it("returns 0 for unknown models rather than crashing", () => {
    expect(priceOf("gpt-99-experimental", 10_000, 10_000)).toBe(0);
  });

  it("returns 0 for zero-priced local models", () => {
    expect(priceOf("gemma3:4b", 100_000, 100_000)).toBe(0);
  });

  it("handles zero-token inputs", () => {
    expect(priceOf("claude-haiku-4-5-20251001", 0, 0)).toBe(0);
  });
});
