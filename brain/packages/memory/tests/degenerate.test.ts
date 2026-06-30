import { describe, expect, it } from "vitest";
import { detectDegenerateRepetition } from "../src/write/degenerate.ts";

describe("detectDegenerateRepetition", () => {
  it("flags a string that is a single phrase repeated", () => {
    const phrase = "user attended a wedding ".repeat(50);
    const r = detectDegenerateRepetition(phrase);
    expect(r.degenerate).toBe(true);
    expect(r.repeatFraction).toBeGreaterThan(0.4);
  });

  it("does not flag a normal-looking output of mixed content", () => {
    const content = `
      The user attended Sarah and Mike's wedding on March 15, 2024.
      The user spent five days on a camping trip in Yellowstone.
      The user is a software engineer at a startup in Berlin.
      The user prefers black coffee in the morning.
      The user's son is named Oliver and just turned three.
      The user enjoys hiking on weekends, especially in spring.
      The user finished reading "The Silent Patient" last weekend.
      The user attended a charity walk and raised $250 for sponsors.
      The user is planning a trip to Japan in October.
      The user prefers green tea in the afternoon over coffee.
    `
      .trim()
      .repeat(2);
    const r = detectDegenerateRepetition(content);
    expect(r.degenerate).toBe(false);
  });

  it("returns non-degenerate for short inputs (sampling unreliable)", () => {
    const r = detectDegenerateRepetition("user attended a wedding".repeat(2));
    expect(r.degenerate).toBe(false);
    expect(r.windowCount).toBe(0);
  });

  it("flags a long output where stride aligns with the repeat period", () => {
    // Window detection works when stride is a multiple of the
    // underlying period: windows at the same phase position match
    // byte-for-byte. Picking a 100-char phrase ensures stride=100
    // aligns with period.
    const phrase =
      "User attended Sarah and Mike's wedding on March 15, 2024 at the local botanical gardens.".padEnd(
        100,
        " ",
      );
    expect(phrase.length).toBe(100);
    const s = phrase.repeat(20); // 2000 chars
    const r = detectDegenerateRepetition(s);
    expect(r.degenerate).toBe(true);
  });

  it("custom maxRepeatFraction tunes sensitivity", () => {
    const phrase = "x".repeat(50) + "y".repeat(800);
    // Default 0.4 — lots of 'y' makes most windows duplicates → degenerate.
    expect(detectDegenerateRepetition(phrase).degenerate).toBe(true);
    // Bump threshold to 0.95 → not degenerate at this level.
    expect(detectDegenerateRepetition(phrase, { maxRepeatFraction: 0.95 }).degenerate).toBe(false);
  });
});
