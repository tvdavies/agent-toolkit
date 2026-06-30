import type { Storage } from "../storage/sqlite.js";
import type { SearchHit } from "../storage/types.js";
import { classifyIntent, type IntentClassification } from "./intent.js";
import type { Reranker } from "./rerank.js";
import { searchBM25WithRetry } from "./retry.js";
import { RRF_DEFAULT_K, reciprocalRankFusion } from "./rrf.js";
import type {
  Retrieval,
  RetrievalHit,
  RetrievalRequestInternal,
  RetrievalResponse,
} from "./types.js";

export type CreateRetrievalOptions = {
  storage: Storage;
  /**
   * BM25 + vector candidate fan-out. Each leg pulls this many candidates
   * before RRF fusion.
   */
  candidateK?: number;
  /** Optional override for intent classification. */
  classifyIntent?: (query: string) => IntentClassification;
  /** Optional reranker — runs after RRF fusion if provided. */
  reranker?: Reranker;
};

const DEFAULT_CANDIDATE_K = 50;

/**
 * Hybrid retrieval pipeline.
 *
 * Stages:
 *  1. Storage.searchBM25 → top `candidateK`.
 *  2. Storage.searchVector → top `candidateK` (only when query embedding present).
 *  3. Intent-aware RRF fuse: per-leg weights based on detected query type.
 *  4. (Optional) cross-encoder rerank over the top fused candidates.
 *  5. Truncate to `topK`.
 */
export function createRetrieval(opts: CreateRetrievalOptions): Retrieval {
  const candidateK = opts.candidateK ?? DEFAULT_CANDIDATE_K;
  const classify = opts.classifyIntent ?? classifyIntent;
  return {
    async search(req: RetrievalRequestInternal): Promise<RetrievalResponse> {
      const intent = classify(req.query);
      const bm25 =
        intent.weights.bm25 > 0
          ? searchBM25WithRetry(opts.storage, req.query, candidateK)
          : { hits: [], attempts: [] };
      const bm25Hits = bm25.hits;
      const vectorHits =
        intent.weights.vector > 0 && req.queryEmbedding !== undefined
          ? opts.storage.searchVector(req.queryEmbedding, candidateK)
          : [];

      let hits = fuseRRF(bm25Hits, vectorHits, intent);
      let rerankerRan = false;
      if (opts.reranker !== undefined && hits.length > 1) {
        // Rerank ahead of truncation so the reranker has the full window
        // (it can refuse to reorder beyond its own windowK internally).
        hits = await opts.reranker.rerank(req.query, hits, hits.length);
        rerankerRan = true;
      }
      const truncated = hits.slice(0, req.topK);
      return {
        hits: truncated,
        diagnostics: {
          bm25Hits: bm25Hits.length,
          vectorHits: vectorHits.length,
          rerankerRan,
          ...(bm25.attempts.length > 1 ? { bm25RetryAttempts: bm25.attempts.length - 1 } : {}),
        },
      };
    },
  };
}

type LegContribution = {
  source: "bm25" | "vector";
  score: number;
  chunk: SearchHit["chunk"];
};

function fuseRRF(
  bm25Hits: readonly SearchHit[],
  vectorHits: readonly SearchHit[],
  intent: IntentClassification,
): RetrievalHit[] {
  const fused = reciprocalRankFusion<LegContribution>(
    [
      {
        candidates: bm25Hits.map((h, i) => ({
          id: h.chunk.id,
          rank: i,
          source: { source: "bm25" as const, score: h.score, chunk: h.chunk },
        })),
        weight: intent.weights.bm25,
      },
      {
        candidates: vectorHits.map((h, i) => ({
          id: h.chunk.id,
          rank: i,
          source: { source: "vector" as const, score: h.score, chunk: h.chunk },
        })),
        weight: intent.weights.vector,
      },
    ],
    RRF_DEFAULT_K,
  );
  return fused.map((r) => {
    const contributions: { bm25?: number; vector?: number } = {};
    let chunk: SearchHit["chunk"] | undefined;
    for (const c of r.contributions) {
      contributions[c.source] = c.score;
      chunk = c.chunk;
    }
    if (chunk === undefined) throw new Error("RRF result without contributions");
    return { chunk, score: r.score, contributions };
  });
}
