/**
 * `buildChatModel(spec, modelId, ...)` — single switch that turns a
 * `ProviderSpec` (from BRAIN-110 config) into something the AI SDK's
 * `generateText` accepts as `model`.
 *
 * Returns either a string id (for the Vercel AI Gateway, which the
 * SDK auto-routes when `AI_GATEWAY_API_KEY` is set) or a configured
 * `LanguageModel` from `@ai-sdk/openai`-compatible providers.
 *
 * Credential resolution: stored token from
 * `~/brain/auth/<provider>.json` wins (passed via `opts.apiKey`),
 * otherwise the conventional env var per type
 * (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AI_GATEWAY_API_KEY`).
 * For `openai-compatible` with no auth at all, we pass a dummy
 * `"local"` string — fine for LM Studio / Ollama which don't
 * validate, breaks loudly on the first 401 for hosted variants
 * that do.
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { buildCodexLanguageModel } from "../auth/oauth/codex-provider.js";
import { ENV_VAR_FOR_TYPE, type ProviderSpec, type ReasoningEffort } from "../config/index.js";

export type ChatModel = string | LanguageModel;

export type BuildChatModelOpts = {
  spec: ProviderSpec;
  modelId: string;
  /** Override env. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Path to <home>/auth/. Required for OAuth-backed providers (codex). */
  authPath?: string;
  /**
   * API key from `<home>/auth/<provider>.json`. When present, this
   * wins over the env-var fallback.
   */
  apiKey?: string;
  /**
   * Reasoning effort for reasoning-capable models. Currently only
   * applied to `codex-subscription` — other types throw because
   * gateway-routed string-id models don't have a provider-options
   * pipe today (would need a wider call-site refactor).
   */
  reasoning?: ReasoningEffort;
};

const UNAUTHENTICATED_LOCAL_KEY = "local";

export function buildChatModel(opts: BuildChatModelOpts): ChatModel {
  const env = opts.env ?? process.env;
  const { spec, modelId } = opts;

  if (opts.reasoning !== undefined && spec.type !== "codex-subscription") {
    throw new Error(
      `model has \`reasoning: ${opts.reasoning}\` but provider type is \`${spec.type}\`. ` +
        "Only codex-subscription supports reasoning today; gateway/openai-direct routing " +
        "would need a wider call-site refactor to pass providerOptions through.",
    );
  }

  switch (spec.type) {
    case "vercel-ai-gateway":
      // The AI SDK routes `"google/..."` / `"anthropic/..."` / `"openai/..."`
      // strings through the gateway when `AI_GATEWAY_API_KEY` is set.
      // Returning the bare id keeps the call site simple.
      return modelId;

    case "openai":
      return createOpenAI({
        apiKey: requireKey(spec, env, opts.apiKey),
      }).chat(modelId);

    case "openai-compatible":
      return createOpenAI({
        baseURL: requireBaseUrl(spec),
        apiKey: opts.apiKey ?? UNAUTHENTICATED_LOCAL_KEY,
      }).chat(modelId);

    case "anthropic":
      throw new Error(
        "provider type 'anthropic' is not wired yet. Use vercel-ai-gateway with " +
          "`anthropic/<model-id>` for now.",
      );

    case "local-heuristic":
      throw new Error(
        "provider type 'local-heuristic' is reranker-only — it has no chat surface. " +
          "Use it as `purposes.reranker`, not for extractor / observer / consolidator / contextualiser.",
      );

    case "codex-subscription": {
      if (!opts.authPath) {
        throw new Error(
          "provider type 'codex-subscription' requires `authPath` (path to <home>/auth/) so the " +
            "stored OAuth token can be read. Caller wiring is missing the home-dir hand-off.",
        );
      }
      const debug = env.BRAIN_CODEX_DEBUG === "1" || env.BRAIN_CODEX_DEBUG === "true";
      // buildCodexLanguageModel wraps `.responses(modelId)` with the
      // Codex-specific quirks: store=false, instructions extracted from
      // system messages, textVerbosity=low, force-streaming via
      // doGenerate→doStream accumulation.
      return buildCodexLanguageModel({
        authPath: opts.authPath,
        modelId,
        debug,
        ...(opts.reasoning !== undefined ? { reasoning: opts.reasoning } : {}),
      });
    }
  }
}

/**
 * Resolve an API key for a provider type that requires one. Stored
 * credential (`opts.apiKey`) wins; falls back to the conventional
 * env var declared in `ENV_VAR_FOR_TYPE`. Throws when neither
 * exists.
 */
function requireKey(spec: ProviderSpec, env: NodeJS.ProcessEnv, apiKey?: string): string {
  if (apiKey !== undefined && apiKey.length > 0) return apiKey;
  const envName = ENV_VAR_FOR_TYPE[spec.type];
  if (envName === undefined) {
    throw new Error(
      `provider type '${spec.type}' requires a stored credential in ~/brain/auth/<provider>.json.`,
    );
  }
  const value = env[envName];
  if (!value) {
    throw new Error(
      `provider type '${spec.type}': no stored credential and ${envName} is not set in env.`,
    );
  }
  return value;
}

function requireBaseUrl(spec: ProviderSpec): string {
  if (!spec.base_url) {
    throw new Error(`provider type '${spec.type}' requires \`base_url\` in the config.`);
  }
  return spec.base_url;
}
