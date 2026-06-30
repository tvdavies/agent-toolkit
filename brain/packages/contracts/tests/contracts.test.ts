import { describe, expect, it } from "vitest";
import { MemoryEvent, RoutingDecision, SessionEvent, SourceRef } from "../src/index.ts";

describe("SourceRef", () => {
  it("accepts known kinds", () => {
    expect(SourceRef.parse({ kind: "slack", id: "C123" }).kind).toBe("slack");
    expect(SourceRef.parse({ kind: "linear", id: "LLE-1" }).kind).toBe("linear");
  });

  it("rejects unknown kind", () => {
    expect(() => SourceRef.parse({ kind: "notion", id: "x" })).toThrow();
  });

  it("validates optional url as a URL", () => {
    expect(() => SourceRef.parse({ kind: "slack", id: "C1", url: "not-a-url" })).toThrow();
    expect(SourceRef.parse({ kind: "slack", id: "C1", url: "https://slack.com/c1" })).toBeDefined();
  });
});

describe("MemoryEvent", () => {
  it("discriminates on `kind`", () => {
    expect(MemoryEvent.parse({ kind: "user-turn", text: "hi" })).toEqual({
      kind: "user-turn",
      text: "hi",
    });
    expect(MemoryEvent.parse({ kind: "assistant-turn", text: "hello" })).toBeDefined();
    expect(
      MemoryEvent.parse({
        kind: "ingested-item",
        source: { kind: "slack", id: "1" },
        content: "x",
      }),
    ).toBeDefined();
    expect(
      MemoryEvent.parse({
        kind: "tool-call",
        tool: "slack.search",
        args: { q: "x" },
        result: [],
      }),
    ).toBeDefined();
  });

  it("rejects unknown kind", () => {
    expect(() => MemoryEvent.parse({ kind: "mystery" })).toThrow();
  });
});

describe("RoutingDecision", () => {
  it("restricts provider to enum", () => {
    expect(
      RoutingDecision.parse({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
      }),
    ).toBeDefined();
    expect(() => RoutingDecision.parse({ provider: "cohere", model: "x" })).toThrow();
  });

  it("accepts optional temperature/maxTokens within bounds", () => {
    expect(
      RoutingDecision.parse({
        provider: "openai",
        model: "gpt-4o",
        temperature: 0.7,
        maxTokens: 1024,
      }),
    ).toBeDefined();
    expect(() =>
      RoutingDecision.parse({ provider: "openai", model: "gpt-4o", temperature: 3 }),
    ).toThrow();
  });
});

describe("SessionEvent", () => {
  it("accepts well-formed turn-start and turn-end", () => {
    const ts = new Date();
    expect(SessionEvent.parse({ type: "turn-start", ts, turnId: "t1", input: "hi" })).toBeDefined();
    expect(
      SessionEvent.parse({ type: "turn-end", ts, turnId: "t1", output: "hello" }),
    ).toBeDefined();
  });

  it("accepts model-call with token counts + cost", () => {
    expect(
      SessionEvent.parse({
        type: "model-call",
        ts: new Date(),
        turnId: "t1",
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.000_35,
        latencyMs: 820,
      }),
    ).toBeDefined();
  });
});
