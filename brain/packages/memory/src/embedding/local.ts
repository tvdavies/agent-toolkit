import { embedMany } from "ai";
import { createLocalProvider, type LocalProviderOptions } from "../providers/local.js";
import type { Embedder } from "./types.js";

export type LocalEmbedderOptions = LocalProviderOptions & {
  /** Model id as exposed by the local server (e.g. LM Studio's `/v1/models`). */
  readonly model: string;
  /** Output dimensionality. Must match what the model emits. */
  readonly dim: number;
  /** Batch size per request to the local server. Default 96. */
  readonly batchSize?: number;
};

const DEFAULT_BATCH_SIZE = 96;

/**
 * Embedder backed by a local OpenAI-compatible server (LM Studio, Ollama,
 * vLLM, etc.). Uses `createLocalProvider` for connection wiring.
 *
 * Example (LM Studio + Nomic Embed Text v1.5):
 *
 *   const embedder = createLocalEmbedder({
 *     model: "text-embedding-nomic-embed-text-v1.5",
 *     dim: 768,
 *   });
 */
export function createLocalEmbedder(opts: LocalEmbedderOptions): Embedder {
  const provider = createLocalProvider({
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  });
  const embedModel = provider.embedding(opts.model);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  return {
    id: opts.model,
    dim: opts.dim,
    async embed(texts) {
      if (texts.length === 0) return [];
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const slice = texts.slice(i, i + batchSize);
        const result = await embedMany({ model: embedModel, values: [...slice] });
        for (const e of result.embeddings) out.push(new Float32Array(e));
      }
      return out;
    },
  };
}
