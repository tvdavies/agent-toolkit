import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { UsageMeter } from "../usage.js";
import type { RetrievalHit } from "./types.js";

/**
 * Cross-encoder reranker. Takes the top-N fused candidates from the
 * BM25+vector hybrid and re-orders them by query relevance using an LLM
 * call. Standard finishing move in hybrid retrieval — Jeff's pipeline
 * includes it; we left it out in M2.a–M2.c.
 *
 * `createLLMReranker(...)` accepts either a gateway model id string OR
 * any AI SDK `LanguageModel` (so a Codex-built provider works fine).
 * Default is Haiku 4.5 via the gateway.
 *
 * For local sub-millisecond reranking with no LLM call, see
 * `createHeuristicReranker` (MMR over embeddings + near-dup
 * suppression).
 */
export interface Reranker {
  rerank(query: string, candidates: readonly RetrievalHit[], topK: number): Promise<RetrievalHit[]>;
}

export type LLMRerankerOptions = {
  /**
   * Either a gateway model id string (e.g. `"anthropic/claude-haiku-4-5-20251001"`)
   * or any AI SDK `LanguageModel`. Default: Claude Haiku 4.5 via the gateway.
   */
  readonly model?: string | LanguageModel;
  /**
   * Top-N candidates to re-rank. Items beyond this stay in their fused
   * order. Default: 20 (matches Jeff's `rerankTopN`).
   */
  readonly windowK?: number;
  /**
   * Override the usage-attribution id. Defaults to the model id string,
   * or `${provider}/${modelId}` when a `LanguageModel` is passed.
   */
  readonly usageId?: string;
  /** Optional usage meter for cost attribution. */
  readonly usage?: UsageMeter;
};

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5-20251001";
const DEFAULT_WINDOW_K = 20;

const RankingSchema = z.object({
  ranking: z.array(z.number().int().nonnegative()),
});

const SYSTEM_PROMPT = `You are a search-result reranker. Given a query and a numbered list of candidate passages, return the indices (0-based) ordered from most to least relevant to the query. Use only the indices you were given; do not invent new ones; do not duplicate.`;

export function createLLMReranker(opts: LLMRerankerOptions = {}): Reranker {
  const model = opts.model ?? DEFAULT_MODEL;
  const windowK = opts.windowK ?? DEFAULT_WINDOW_K;
  const usageId = opts.usageId ?? deriveUsageId(model);

  return {
    async rerank(query, candidates, topK) {
      if (candidates.length === 0) return [];
      const window = candidates.slice(0, windowK);
      const tail = candidates.slice(windowK);
      if (window.length <= 1) return candidates.slice(0, topK);

      const passages = window
        .map((c, i) => `[${i}] ${truncate(c.chunk.content, 600)}`)
        .join("\n\n");
      const prompt = `Query: ${query}\n\nPassages:\n${passages}\n\nReturn JSON: { "ranking": [<indices in relevance order>] }`;

      let order: number[];
      try {
        const result = await generateObject({
          model,
          system: SYSTEM_PROMPT,
          prompt,
          schema: RankingSchema,
          temperature: 0,
        });
        opts.usage?.record(
          "reranker",
          usageId,
          result.usage?.inputTokens ?? 0,
          result.usage?.outputTokens ?? 0,
        );
        order = sanitiseOrder(result.object.ranking, window.length);
      } catch {
        // On any failure, fall back to the fused order untouched.
        order = window.map((_, i) => i);
      }

      const reranked = order
        .map((i) => window[i])
        .filter((x): x is RetrievalHit => x !== undefined);
      // Append any window items the model missed, in fused order.
      const seen = new Set(reranked);
      for (const w of window) if (!seen.has(w)) reranked.push(w);

      return [...reranked, ...tail].slice(0, topK);
    },
  };
}

/**
 * Coerce an LLM-emitted ranking array into a valid permutation of
 * [0, length): drop out-of-range, dedupe, preserve given order. Missing
 * indices are appended in numerical order at the end.
 */
function sanitiseOrder(raw: readonly number[], length: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const n of raw) {
    if (Number.isInteger(n) && n >= 0 && n < length && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  for (let i = 0; i < length; i++) {
    if (!seen.has(i)) out.push(i);
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function deriveUsageId(model: string | LanguageModel): string {
  if (typeof model === "string") return model;
  // LanguageModelV2/V3: { provider, modelId, ... }. Fall back to "?"
  // if either is missing — usage attribution is best-effort.
  const provider = (model as { provider?: string }).provider ?? "?";
  const id = (model as { modelId?: string }).modelId ?? "?";
  return `${provider}/${id}`;
}
