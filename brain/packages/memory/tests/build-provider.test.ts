import { describe, expect, it } from "vitest";
import type { ProviderSpec } from "../src/config/index.ts";
import { buildChatModel } from "../src/providers/build.ts";

describe("buildChatModel", () => {
  it("vercel-ai-gateway returns the bare model id (SDK auto-routes)", () => {
    const spec: ProviderSpec = { type: "vercel-ai-gateway" };
    expect(buildChatModel({ spec, modelId: "google/gemini-3-flash", env: {} })).toBe(
      "google/gemini-3-flash",
    );
  });

  it("openai-compatible builds an AI SDK provider with stored credential", () => {
    const spec: ProviderSpec = {
      type: "openai-compatible",
      base_url: "https://staging.example.com/v1",
    };
    const model = buildChatModel({
      spec,
      modelId: "google/gemma-4-31b",
      env: {},
      apiKey: "stored-key",
    });
    expect(typeof model).not.toBe("string");
    expect((model as { modelId: string }).modelId).toBe("google/gemma-4-31b");
  });

  it("openai-compatible without auth uses dummy 'local' key (LM Studio / Ollama path)", () => {
    const spec: ProviderSpec = {
      type: "openai-compatible",
      base_url: "http://localhost:1234/v1",
    };
    const model = buildChatModel({ spec, modelId: "qwen/qwen3-4b-2507", env: {} });
    expect(typeof model).not.toBe("string");
    expect((model as { modelId: string }).modelId).toBe("qwen/qwen3-4b-2507");
  });

  it("openai-compatible without base_url errors clearly", () => {
    const spec: ProviderSpec = { type: "openai-compatible" };
    expect(() => buildChatModel({ spec, modelId: "m", env: {}, apiKey: "k" })).toThrow(/base_url/);
  });

  it("openai falls back to OPENAI_API_KEY env when no stored credential", () => {
    const spec: ProviderSpec = { type: "openai" };
    const model = buildChatModel({
      spec,
      modelId: "gpt-5",
      env: { OPENAI_API_KEY: "test-key" },
    });
    expect(typeof model).not.toBe("string");
  });

  it("openai with stored credential overrides env", () => {
    const spec: ProviderSpec = { type: "openai" };
    const model = buildChatModel({
      spec,
      modelId: "gpt-5",
      env: { OPENAI_API_KEY: "env-key" },
      apiKey: "stored-key",
    });
    expect(typeof model).not.toBe("string");
  });

  it("openai without stored credential and without OPENAI_API_KEY errors clearly", () => {
    const spec: ProviderSpec = { type: "openai" };
    expect(() => buildChatModel({ spec, modelId: "gpt-5", env: {} })).toThrow(/OPENAI_API_KEY/);
  });

  it("anthropic throws a hint to use the gateway for now", () => {
    const spec: ProviderSpec = { type: "anthropic" };
    expect(() =>
      buildChatModel({ spec, modelId: "claude-haiku-4-5", env: { ANTHROPIC_API_KEY: "k" } }),
    ).toThrow(/vercel-ai-gateway/);
  });

  it("codex-subscription requires authPath to be passed in", () => {
    const spec: ProviderSpec = { type: "codex-subscription" };
    expect(() => buildChatModel({ spec, modelId: "gpt-5.1", env: {} })).toThrow(
      /requires `authPath`/,
    );
  });
});
