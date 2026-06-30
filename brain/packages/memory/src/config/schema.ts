/**
 * Schema for `~/brain/config.yaml`.
 *
 * Three layers:
 *   - providers — where + how to authenticate
 *   - models    — what id to use, optional embedding dimension
 *   - purposes  — which model fills each role (extractor, embedder, …)
 *
 * Cross-references are validated: every model's `provider` must
 * reference an existing provider; every purpose value must reference
 * an existing model. Provider `type` is a closed set so a typo at
 * the YAML level fails loud at config-load time, not at first call.
 */

import { z } from "zod";

export const PROVIDER_TYPES = [
  "codex-subscription",
  "vercel-ai-gateway",
  "anthropic",
  "openai",
  // Any OpenAI-compatible HTTP server. Covers LM Studio, Ollama,
  // vLLM, OpenRouter, hosted-llama, etc. Set `base_url` explicitly.
  // Auth: stored credential via `brain auth login --provider <name>
  // --key ...`; servers that don't validate auth (LM Studio, Ollama)
  // work without one.
  "openai-compatible",
  // Local heuristic reranker (no LLM, sub-ms). Reranker-only — used
  // as `purposes.reranker` not as a chat provider. Model fields like
  // `id` are required by the schema for uniformity but ignored.
  //
  // TODO(architecture): this is a "provider" only by squinting — it's
  // really a built-in reranker implementation that doesn't fit the
  // provider/model/auth shape. When we build a proper module/extension
  // registry, rerankers (heuristic / LLM cross-encoder / ONNX
  // cross-encoder / etc.) become siblings of each other, independent
  // of providers. Same applies to local embedders sneaking through
  // openai-compatible. Acceptable wart until the registry lands.
  "local-heuristic",
] as const;

export const ProviderType = z.enum(PROVIDER_TYPES);
export type ProviderType = z.infer<typeof ProviderType>;

export const ProviderSpec = z
  .object({
    type: ProviderType,
    /** Override base URL — required for openai-compatible providers. */
    base_url: z.string().url().optional(),
  })
  .strict();
export type ProviderSpec = z.infer<typeof ProviderSpec>;

// Conventional env var per provider type. Stored credentials
// (`brain auth login --provider <name> --key ...`) hydrate into these
// at openBrain time; users who already have an env var set get that
// as a fallback. Both paths converge on the same env name so the AI
// SDK's gateway-routing layer (string-id models) keeps working.
export const ENV_VAR_FOR_TYPE: Partial<Record<ProviderType, string>> = {
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

// `off` is a Pi-style "don't send the field at all" — the model uses
// its own default. Distinct from `none`: `none` is an explicit OpenAI
// SDK value (GPT-5.1 only) telling the model to skip reasoning;
// `off` means we don't tell the model anything and it picks.
// `xhigh` is GPT-5.1-Codex-Max only. Setting either on an
// unsupported model warns and falls back.
export const REASONING_EFFORTS = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const ReasoningEffort = z.enum(REASONING_EFFORTS);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const ModelSpec = z
  .object({
    /** Provider key — must exist in `providers`. */
    provider: z.string().min(1),
    /** Model id as the provider knows it (e.g. `google/gemini-3-flash`). */
    id: z.string().min(1),
    /** Embedding dimension. Required for embedder models, ignored otherwise. */
    dim: z.number().int().positive().optional(),
    /**
     * Reasoning effort for reasoning-capable models (gpt-5*, o-series).
     * Currently only honoured by `codex-subscription` providers — other
     * provider types reject this field at build time so misconfiguration
     * fails loud rather than being silently ignored.
     */
    reasoning: ReasoningEffort.optional(),
  })
  .strict();
export type ModelSpec = z.infer<typeof ModelSpec>;

export const PURPOSES = [
  "extractor",
  "observer",
  "consolidator",
  "contextualiser",
  "embedder",
  "reranker",
] as const;

export const Purpose = z.enum(PURPOSES);
export type Purpose = z.infer<typeof Purpose>;

const PurposeMap = z.object({
  extractor: z.string().min(1),
  observer: z.string().min(1),
  consolidator: z.string().min(1),
  contextualiser: z.string().min(1),
  embedder: z.string().min(1),
  reranker: z.string().min(1),
});
export type PurposeMap = z.infer<typeof PurposeMap>;

/**
 * Optional caching layer for the embedder. Persistent (`SQLite at
 * <home>/cache/embeddings.sqlite`), keyed by `(model_id, text)`,
 * LRU-evicted when entries exceed `max_entries`. Embeddings are
 * deterministic so there's no TTL — switching embedder model
 * invalidates naturally.
 */
const ModuleRef = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1), enabled: z.boolean().optional() }).strict(),
]);
export type ModuleRef = z.infer<typeof ModuleRef>;

const PipelineSection = z
  .object({
    remember: z
      .object({
        /** Writers run in order to produce persisted chunks. */
        writers: z.array(ModuleRef).optional(),
        /** Writers run by the daemon in async mode. Defaults to writers minus verbatim. */
        async_writers: z.array(ModuleRef).optional(),
        /** Synchronous writer for async-mode immediate recall. */
        sync_writer: ModuleRef.optional(),
      })
      .strict()
      .optional(),
    recall: z
      .object({
        /** Retrieval/ranking modules. Initial migration validates and documents ordering. */
        modules: z.array(ModuleRef).optional(),
      })
      .strict()
      .optional(),
    cycle: z
      .object({ phases: z.array(ModuleRef).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const CacheSection = z
  .object({
    embeddings: z
      .object({
        enabled: z.boolean().optional(),
        max_entries: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const BrainConfig = z
  .object({
    providers: z.record(z.string().min(1), ProviderSpec),
    models: z.record(z.string().min(1), ModelSpec),
    purposes: PurposeMap,
    cache: CacheSection,
    pipeline: PipelineSection,
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const providerKeys = new Set(Object.keys(cfg.providers));
    for (const [name, model] of Object.entries(cfg.models)) {
      if (!providerKeys.has(model.provider)) {
        ctx.addIssue({
          code: "custom",
          path: ["models", name, "provider"],
          message: `model "${name}" references unknown provider "${model.provider}". Known providers: ${[...providerKeys].sort().join(", ") || "(none)"}`,
        });
      }
    }
    const modelKeys = new Set(Object.keys(cfg.models));
    for (const purpose of PURPOSES) {
      const target = cfg.purposes[purpose];
      if (!modelKeys.has(target)) {
        ctx.addIssue({
          code: "custom",
          path: ["purposes", purpose],
          message: `purpose "${purpose}" references unknown model "${target}". Known models: ${[...modelKeys].sort().join(", ") || "(none)"}`,
        });
      }
    }
  });
export type BrainConfig = z.infer<typeof BrainConfig>;
