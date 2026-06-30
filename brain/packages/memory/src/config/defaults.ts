/**
 * Sensible-defaults config for installs without a `~/brain/config.yaml`.
 *
 * Mirrors today's hardcoded stack (gateway for embedder + reranker,
 * gemini-3-flash for extraction). Lets unconfigured installs work the
 * same as today; the config file is opt-in for users who want to
 * override or use Codex subscription auth.
 */

import type { BrainConfig } from "./schema.js";

export function defaultConfig(): BrainConfig {
  return {
    providers: {
      gateway: { type: "vercel-ai-gateway" },
    },
    models: {
      "default-extract": { provider: "gateway", id: "google/gemini-3-flash" },
      "default-embed": { provider: "gateway", id: "google/gemini-embedding-001", dim: 3072 },
      "default-rerank": { provider: "gateway", id: "claude-haiku-4-5-20251001" },
    },
    purposes: {
      extractor: "default-extract",
      observer: "default-extract",
      consolidator: "default-extract",
      contextualiser: "default-extract",
      embedder: "default-embed",
      reranker: "default-rerank",
    },
    pipeline: {
      remember: {
        writers: [
          "brain/verbatim-writer",
          "brain/procedural-memory",
          "brain/deterministic-extraction",
          "brain/llm-extraction",
          "brain/observation-writer",
        ],
        async_writers: [
          "brain/procedural-memory",
          "brain/deterministic-extraction",
          "brain/llm-extraction",
          "brain/observation-writer",
        ],
        sync_writer: "brain/verbatim-writer",
      },
      recall: {
        modules: [
          "brain/temporal-expansion",
          "brain/intent-planner",
          "brain/bm25",
          "brain/vector",
          "brain/entity",
          "brain/fallback-query-rewrite",
          "brain/rrf",
          "brain/cosine-rescore",
          "brain/type-boost",
          "brain/temporal-decay",
          "brain/status-penalty",
          "brain/assistant-reference-boost",
          "brain/backlink-boost",
          "brain/authority-boost",
          "brain/usage-boost",
          "brain/reranker",
          "brain/retrieval-log",
        ],
      },
      cycle: {
        phases: [
          "brain/link-fix",
          "brain/reflect",
          "brain/synthesize",
          "brain/dedup",
          "brain/stale",
          "brain/patterns",
        ],
      },
    },
  };
}
