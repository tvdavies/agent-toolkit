import { describe, expect, it } from "vitest";
import { createContextualiser } from "../src/write/contextualise.ts";

describe("createContextualiser apply()", () => {
  // The build() path requires a real LLM call so we test it via integration.
  // apply() is deterministic and worth pinning.

  const fakeModel = { id: "test-model" } as never;
  const ctx = createContextualiser({ model: fakeModel, modelId: "test:v1" });

  it("prepends the canonical Context: marker when prefix is non-empty", () => {
    const out = ctx.apply("User attended the wedding.", "Spring 2024 personal updates.");
    expect(out).toBe("Context: Spring 2024 personal updates.\n\nUser attended the wedding.");
  });

  it("returns content unchanged when prefix is empty", () => {
    expect(ctx.apply("hello", "")).toBe("hello");
    expect(ctx.apply("hello", "   ")).toBe("hello");
  });

  it("trims whitespace around the prefix", () => {
    expect(ctx.apply("body", "  some context  ")).toBe("Context: some context\n\nbody");
  });
});
