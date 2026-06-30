import { createOpenAI } from "@ai-sdk/openai";

export type LocalProviderOptions = {
  /**
   * OpenAI-compatible base URL. Defaults: env `LMSTUDIO_BASE_URL` →
   * env `OLLAMA_HOST` (with `/v1` appended) → `http://localhost:1234/v1`
   * (LM Studio default).
   *
   * Heads up: when both `LMSTUDIO_BASE_URL` and `OLLAMA_HOST` are unset
   * but the user has only LM Studio running, this is fine. When
   * `OLLAMA_HOST` is set but Ollama isn't actually running on that
   * port, every call silently 404s. Always pass `baseURL` explicitly
   * for LM Studio if your env has `OLLAMA_HOST` set for unrelated reasons.
   */
  readonly baseURL?: string;
  /** API key. Local servers don't validate; "local" is a sensible dummy. */
  readonly apiKey?: string;
};

/**
 * Build an AI SDK provider pointed at a local OpenAI-compatible server
 * (LM Studio, Ollama with `/v1`, vLLM, llama.cpp's server, etc.). The
 * returned object is an AI SDK provider — call it with a model name to
 * get a `LanguageModel`, or `.embedding(...)` for an embedding model.
 *
 * Example:
 *   const local = createLocalProvider({ baseURL: "http://localhost:1234/v1" });
 *   const model = local.chat("qwen/qwen3.6-27b");
 *   await generateText({ model, prompt: "..." });
 *
 * Note: prefer `.chat(modelId)` over `(modelId)` when targeting local
 * servers — the bare callable defaults to OpenAI's Responses API in
 * recent SDK versions, which not all local servers implement.
 */
export function createLocalProvider(opts: LocalProviderOptions = {}) {
  const baseURL = opts.baseURL ?? defaultLocalBaseURL();
  return createOpenAI({
    baseURL,
    apiKey: opts.apiKey ?? "local",
  });
}

function defaultLocalBaseURL(): string {
  if (process.env.LMSTUDIO_BASE_URL) return process.env.LMSTUDIO_BASE_URL;
  if (process.env.OLLAMA_HOST) {
    const base = process.env.OLLAMA_HOST.replace(/\/$/, "");
    return base.endsWith("/v1") ? base : `${base}/v1`;
  }
  return "http://localhost:1234/v1";
}
