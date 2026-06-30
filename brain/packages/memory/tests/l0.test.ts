import { describe, expect, test } from "bun:test";
import {
  appendL0Observation,
  createL0Buffer,
  extractL0Entities,
  inferL0Intent,
  renderL0Reminder,
} from "../src/l0.js";

describe("L0 working memory", () => {
  test("appends, compacts, and renders observations", () => {
    let b = createL0Buffer();
    b = appendL0Observation(
      b,
      {
        at: "t1",
        intent: "plan",
        outcome: "ok",
        entities: ["Brain", "Brain"],
        summary: "made a plan",
      },
      { maxObservations: 1 },
    );
    b = appendL0Observation(
      b,
      { at: "t2", intent: "ask", outcome: "partial", entities: ["Jeff"], summary: "x".repeat(20) },
      { maxObservations: 1, maxSummaryChars: 10 },
    );
    expect(b.observations).toHaveLength(1);
    expect(b.observations[0]?.summary.endsWith("…")).toBe(true);
    expect(renderL0Reminder(b)).toContain("Recent working memory");
  });

  test("infers intent and extracts entities", () => {
    expect(inferL0Intent("Can you plan Phase Two?")).toBe("plan");
    expect(extractL0Entities("Jeff Brain with Tom")).toContain("Jeff Brain");
  });
});
