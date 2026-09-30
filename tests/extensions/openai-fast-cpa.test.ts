import { describe, expect, test } from "bun:test";
import openAIFast, { fastProviderIds, isFastModel } from "../../extensions/openai-fast-cpa.ts";

describe("isFastModel", () => {
  test("keeps every model from the original allowlist", () => {
    for (const id of ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(isFastModel(id)).toBe(true);
    }
  });

  test("includes newer GPT models without listing them", () => {
    for (const id of ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra", "gpt-6.1-sol", "gpt-7", "gpt-6.2-terra"]) {
      expect(isFastModel(id)).toBe(true);
    }
  });

  test("excludes older, small and non-GPT models", () => {
    for (const id of ["gpt-5.3", "gpt-5", "gpt-4.1", "gpt-5.4-mini", "gpt-6-nano", "gpt-5.3-codex-spark", "o3", "gpt-image-2", "codex-auto-review"]) {
      expect(isFastModel(id)).toBe(false);
    }
  });

  test("honours explicit opt-outs", () => {
    expect(isFastModel("gpt-6.1-sol", { PI_OPENAI_FAST_EXCLUDE_MODELS: "gpt-6-luna, GPT-6.1-SOL" })).toBe(false);
    expect(isFastModel("gpt-6-sol", { PI_OPENAI_FAST_EXCLUDE_MODELS: "gpt-6-luna" })).toBe(true);
  });
});

describe("fastProviderIds", () => {
  test("defaults to openai-codex and accepts extra CPA-routed providers", () => {
    expect([...fastProviderIds({})]).toEqual(["openai-codex"]);
    expect([...fastProviderIds({ PI_OPENAI_FAST_PROVIDERS: "sal-openai, other" })]).toEqual(["openai-codex", "sal-openai", "other"]);
  });
});

describe("before_provider_request", () => {
  type Handler = (event: { payload: unknown }, ctx: unknown) => Promise<unknown>;
  function load() {
    const handlers = new Map<string, Handler>();
    openAIFast({ on: (name: string, handler: Handler) => handlers.set(name, handler), registerCommand() {} } as never);
    const request = handlers.get("before_provider_request")!;
    return (provider: string, model: string, payload: Record<string, unknown> = { model }) =>
      request({ payload }, { hasUI: false, model: { provider, id: model } });
  }

  test("adds the priority tier for a newer model on a CPA-routed provider", async () => {
    expect(await load()("openai-codex", "gpt-6.1-sol")).toEqual({ model: "gpt-6.1-sol", service_tier: "priority" });
  });

  test("leaves other providers, unsupported models and explicit tiers unchanged", async () => {
    const request = load();
    expect(await request("openai", "gpt-6.1-sol")).toBeUndefined();
    expect(await request("openai-codex", "gpt-5.4-mini")).toBeUndefined();
    expect(await request("openai-codex", "gpt-6-sol", { model: "gpt-6-sol", service_tier: "flex" })).toBeUndefined();
  });

  test("applies to a provider added through PI_OPENAI_FAST_PROVIDERS", async () => {
    const previous = process.env.PI_OPENAI_FAST_PROVIDERS;
    process.env.PI_OPENAI_FAST_PROVIDERS = "sal-openai";
    try {
      expect(await load()("sal-openai", "gpt-6.1-sol")).toEqual({ model: "gpt-6.1-sol", service_tier: "priority" });
    } finally {
      if (previous === undefined) delete process.env.PI_OPENAI_FAST_PROVIDERS;
      else process.env.PI_OPENAI_FAST_PROVIDERS = previous;
    }
  });
});
