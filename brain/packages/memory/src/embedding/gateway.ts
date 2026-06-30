import { embedMany } from "ai";
import type { UsageMeter } from "../usage.js";
import type { Embedder } from "./types.js";

export type GatewayEmbedderOptions = {
  /**
   * Vercel AI Gateway model id. Default: `google/gemini-embedding-001`
   * (3072-dim native, $0.15/M tokens, multilingual). Other reasonable
   * picks: `openai/text-embedding-3-small` (1536-dim), or
   * `openai/text-embedding-3-large` (3072-dim).
   */
  readonly model?: string;
  /**
   * Output dimensionality. Must match what the underlying model emits at
   * the gateway. Defaults to 3072 (Gemini Embedding 001 native dim). If
   * we ever wire `outputDimensionality` through provider options to use
   * Matryoshka truncation, lower this accordingly.
   */
  readonly dim?: number;
  /** Optional batch size. Caller may already chunk; this caps per-call. */
  readonly batchSize?: number;
  /** Optional usage meter; embedder records input tokens (no output). */
  readonly usage?: UsageMeter;
};

const DEFAULT_MODEL = "google/gemini-embedding-001";
const DEFAULT_DIM = 3072;
const DEFAULT_BATCH_SIZE = 96;

/**
 * Hosted embedder via the Vercel AI Gateway. Picks up `AI_GATEWAY_API_KEY`
 * from the process env.
 */
export function createGatewayEmbedder(opts: GatewayEmbedderOptions = {}): Embedder {
  const model = opts.model ?? DEFAULT_MODEL;
  const dim = opts.dim ?? DEFAULT_DIM;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  return {
    id: model,
    dim,
    async embed(texts) {
      if (texts.length === 0) return [];
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const slice = texts.slice(i, i + batchSize);
        const result = await embedMany({ model, values: [...slice] });
        // AI SDK's embedMany returns `usage.tokens` (input only). We
        // surface it as inputTokens; outputTokens is always 0 for
        // embeddings.
        const tokens = (result as { usage?: { tokens?: number } }).usage?.tokens ?? 0;
        opts.usage?.record("embedder", model, tokens, 0);
        for (const e of result.embeddings) out.push(new Float32Array(e));
      }
      return out;
    },
  };
}
