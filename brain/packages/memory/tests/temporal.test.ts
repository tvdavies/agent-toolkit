import { describe, expect, it } from "vitest";
import {
  applyTimeDecay,
  DEFAULT_DECAY_DAYS,
  parseAnchorDate,
  renderChunkContent,
} from "../src/retrieval/temporal.ts";

describe("parseAnchorDate", () => {
  it("parses LongMemEval format with day-of-week marker", () => {
    const d = parseAnchorDate("2023/05/30 (Tue) 23:40");
    expect(d).toBeDefined();
    expect(d?.getUTCFullYear()).toBe(2023);
    expect(d?.getUTCMonth()).toBe(4); // May = 4
    expect(d?.getUTCDate()).toBe(30);
  });

  it("parses ISO without day-of-week", () => {
    const d = parseAnchorDate("2023-05-30T23:40:00Z");
    expect(d?.toISOString()).toBe("2023-05-30T23:40:00.000Z");
  });

  it("returns undefined on unparseable input", () => {
    expect(parseAnchorDate("not a date")).toBeUndefined();
  });
});

describe("applyTimeDecay", () => {
  const anchor = parseAnchorDate("2023-06-01T00:00:00Z");
  if (anchor === undefined) throw new Error("test setup: bad anchor");

  it("returns score unchanged when chunk recordedAt is missing", () => {
    expect(applyTimeDecay(1, undefined, anchor)).toBe(1);
  });

  it("returns score unchanged when chunk recordedAt is unparseable", () => {
    expect(applyTimeDecay(1, "garbage", anchor)).toBe(1);
  });

  it("returns score × 1 when chunk date == anchor", () => {
    expect(applyTimeDecay(1, "2023-06-01T00:00:00Z", anchor)).toBeCloseTo(1, 5);
  });

  it("decays by exp(-1) at exactly DEFAULT_DECAY_DAYS away", () => {
    const chunkDate = new Date(anchor.getTime() + DEFAULT_DECAY_DAYS * 24 * 60 * 60 * 1000);
    expect(applyTimeDecay(1, chunkDate.toISOString(), anchor)).toBeCloseTo(Math.exp(-1), 4);
  });

  it("treats past and future symmetrically", () => {
    const before = applyTimeDecay(1, "2023-05-15T00:00:00Z", anchor);
    const after = applyTimeDecay(1, "2023-06-18T00:00:00Z", anchor);
    expect(before).toBeCloseTo(after, 5);
  });

  it("LongMemEval-format chunk dates are accepted", () => {
    const lmAnchor = parseAnchorDate("2023/05/30 (Tue) 23:40");
    if (lmAnchor === undefined) throw new Error("test setup");
    const score = applyTimeDecay(1, "2023/05/20 (Sat) 02:21", lmAnchor);
    // ~10.9 days back → exp(-10.9/30) ≈ 0.69
    expect(score).toBeGreaterThan(0.6);
    expect(score).toBeLessThan(0.8);
  });

  it("custom decayDays scales the half-life", () => {
    // At 7 days with decayDays=7 → exp(-1) ≈ 0.368
    const chunkDate = new Date(anchor.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(applyTimeDecay(1, chunkDate.toISOString(), anchor, 7)).toBeCloseTo(Math.exp(-1), 4);
  });
});

describe("renderChunkContent", () => {
  it("prepends [YYYY-MM-DD] when metadata has a parseable recordedAt", () => {
    expect(
      renderChunkContent("user attended a wedding", { recordedAt: "2023/05/30 (Tue) 23:40" }),
    ).toBe("[2023-05-30] user attended a wedding");
  });

  it("returns content unchanged when metadata is undefined", () => {
    expect(renderChunkContent("hello", undefined)).toBe("hello");
  });

  it("returns content unchanged when metadata has no recordedAt", () => {
    expect(renderChunkContent("hello", { type: "fact" })).toBe("hello");
  });

  it("returns content unchanged when recordedAt is unparseable", () => {
    expect(renderChunkContent("hello", { recordedAt: "garbage" })).toBe("hello");
  });

  it("works with ISO recordedAt", () => {
    expect(renderChunkContent("event happened", { recordedAt: "2024-03-15T10:00:00Z" })).toBe(
      "[2024-03-15] event happened",
    );
  });
});
