import { describe, expect, it } from "vitest";
import { generateSlug } from "../src/storage/slug.ts";

describe("generateSlug", () => {
  it("strips third-person User prefix and stop words", () => {
    expect(generateSlug("User attended the wedding")).toBe("attended-wedding");
  });

  it("normalises possessives", () => {
    expect(generateSlug("User attended Sarah and Mike's wedding")).toBe(
      "attended-sarah-mike-wedding",
    );
  });

  it("appends date suffix when recordedAt is set", () => {
    expect(generateSlug("User attended the wedding", "2024-03-15")).toBe(
      "attended-wedding-2024-03-15",
    );
  });

  it("accepts ISO date with time component", () => {
    expect(generateSlug("User decided to switch jobs", "2024-04-12T09:30:00Z")).toBe(
      "decided-switch-jobs-2024-04-12",
    );
  });

  it("accepts LME slash-separated date", () => {
    expect(generateSlug("User decided to switch jobs", "2024/04/12")).toBe(
      "decided-switch-jobs-2024-04-12",
    );
  });

  it("strips M5.b1 temporal frontmatter prefixes", () => {
    const body =
      "[Date: 2024-03-15 Friday March 2024]\n\n[Observed on 2024-03-15]\n\nUser attended a wedding";
    expect(generateSlug(body, "2024-03-15")).toBe("attended-wedding-2024-03-15");
  });

  it("caps body at a word boundary under 60 chars", () => {
    const body =
      "User attended Sarah and Mike's wedding on March 15 2024 at a winery in Sonoma Valley California";
    const slug = generateSlug(body);
    // body part (no date suffix) must be ≤60 chars and not end mid-word.
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
    // ends on a complete token from the input
    const tokens = slug.split("-");
    expect(tokens[tokens.length - 1]).toMatch(/^[a-z0-9]+$/);
  });

  it("body cap accommodates date suffix on top", () => {
    const body =
      "User attended Sarah and Mike's wedding on March 15 2024 at a winery in Sonoma Valley California";
    const slug = generateSlug(body, "2024-03-15");
    // 60-char body cap + "-2024-03-15" (11 chars) = 71 total max
    expect(slug.length).toBeLessThanOrEqual(71);
    expect(slug.endsWith("-2024-03-15")).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const inputs = [
      ["User prefers decaf over regular coffee", undefined],
      ["User attended Sarah and Mike's wedding", "2024-03-15"],
      ["[Date: 2024-04-01 Mon April 2024]\n\nUser bought a new TV", "2024-04-01"],
    ] as const;
    for (const [body, date] of inputs) {
      expect(generateSlug(body, date)).toBe(generateSlug(body, date));
    }
  });

  it("preserves digit-rich content like prices and dates", () => {
    expect(generateSlug("User paid $250 for the dinner")).toBe("paid-250-dinner");
  });

  it("returns 'untitled' when content has no significant words", () => {
    expect(generateSlug("the a an of")).toBe("untitled");
    expect(generateSlug("the a an of", "2024-03-15")).toBe("untitled-2024-03-15");
  });

  it("ignores non-ASCII characters cleanly", () => {
    // Non-ASCII gets stripped to spaces — better than crashing or producing garbage.
    expect(generateSlug("User café visit naïve")).toBe("caf-visit-na-ve");
  });

  it("handles empty or whitespace-only body", () => {
    expect(generateSlug("")).toBe("untitled");
    expect(generateSlug("   ")).toBe("untitled");
    expect(generateSlug("", "2024-03-15")).toBe("untitled-2024-03-15");
  });
});
