import { describe, expect, it } from "vitest";
import type { Fact } from "../src/write/cache.ts";
import {
  autoFactTags,
  buildDateTokens,
  enrichFactWithTemporal,
} from "../src/write/temporal-postprocess.ts";

describe("autoFactTags", () => {
  it("extracts ISO dates and projects weekday + month", () => {
    const tags = autoFactTags("User attended event on 2024-03-25.");
    expect(tags).toContain("2024-03-25");
    expect(tags).toContain("Monday");
    expect(tags).toContain("March");
  });

  it("extracts currency amounts with symbol", () => {
    const tags = autoFactTags("User spent $185 on dinner.");
    expect(tags).toContain("$185");
  });

  it("extracts unit quantities preserving unit", () => {
    const tags = autoFactTags("Walk took 45 minutes.");
    expect(tags).toContain("45 minutes");
  });

  it("extracts proper nouns but skips sentence starts", () => {
    const tags = autoFactTags("The user is at Stanford for graduate work.");
    expect(tags).toContain("Stanford");
    expect(tags).not.toContain("The");
  });

  it("returns [] for empty input", () => {
    expect(autoFactTags("")).toEqual([]);
  });

  it("dedupes repeated tokens", () => {
    const tags = autoFactTags("Stanford Stanford Stanford");
    expect(tags.filter((t) => t === "Stanford").length).toBe(1);
  });
});

describe("buildDateTokens", () => {
  it("formats ISO date with weekday and month", () => {
    expect(buildDateTokens("2024-03-25T00:00:00Z")).toBe(
      "[Date: 2024-03-25 Monday March 2024]\n\n",
    );
  });

  it("returns empty string for unparseable input", () => {
    expect(buildDateTokens("not-a-date")).toBe("");
    expect(buildDateTokens("")).toBe("");
    expect(buildDateTokens(undefined)).toBe("");
  });
});

describe("enrichFactWithTemporal", () => {
  const baseFact: Fact = {
    type: "event",
    content: "User had dinner with Sarah.",
  };

  it("prepends date tokens and observed-on marker", () => {
    const enriched = enrichFactWithTemporal(baseFact, "2024-03-25T19:00:00Z");
    expect(enriched.content).toMatch(/^\[Date: 2024-03-25 Monday March 2024\]\n\n\[Observed on /);
    expect(enriched.content).toContain("User had dinner with Sarah.");
  });

  it("merges auto-tags into entities", () => {
    const enriched = enrichFactWithTemporal(baseFact, "2024-03-25T19:00:00Z");
    expect(enriched.entities).toContain("Sarah");
    expect(enriched.entities).toContain("2024-03-25");
    expect(enriched.entities).toContain("Monday");
  });

  it("returns original content when sessionDate undefined", () => {
    const enriched = enrichFactWithTemporal(baseFact, undefined);
    expect(enriched.content).toBe(baseFact.content);
  });

  it("preserves caller-provided entities", () => {
    const enriched = enrichFactWithTemporal(
      { ...baseFact, entities: ["Sarah", "London"] },
      "2024-03-25T19:00:00Z",
    );
    expect(enriched.entities).toContain("Sarah");
    expect(enriched.entities).toContain("London");
  });
});
