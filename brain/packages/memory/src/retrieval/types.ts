import type { Chunk } from "../storage/types.js";

export type RetrievalRequestInternal = {
  query: string;
  /** Optional dense embedding of the query. When set, vector path runs. */
  queryEmbedding?: Float32Array;
  topK: number;
};

/**
 * Score-breakdown bookkeeping per hit. Filled in incrementally
 * as each retrieval-side multiplier fires; emitted on the
 * RetrievedMemory.scoring contract for `brain why` and the eval
 * harness. Optional values default to "no boost applied" so the
 * absence of a key is meaningful (the multiplier didn't fire).
 */
export type ScoringTrace = {
  rrfBase: number;
  cosineBlend?: number;
  typeMultiplier?: number;
  decayMultiplier?: number;
  assistantBoost?: number;
  backlinkBoost?: number;
  authorityMultiplier?: number;
  usageMultiplier?: number;
  statusMultiplier?: number;
  rerankerRanked: boolean;
};

export type RetrievalHit = {
  chunk: Chunk;
  /** Fused score. Higher = better. */
  score: number;
  /** What contributed to the fused score. */
  contributions?: { bm25?: number; vector?: number; entity?: number };
  /** Scoring breakdown — populated by the orchestrator as multipliers fire. */
  scoring?: ScoringTrace;
};

export type RetrievalResponse = {
  hits: RetrievalHit[];
  diagnostics: {
    bm25Hits: number;
    vectorHits: number;
    rerankerRan: boolean;
    bm25RetryAttempts?: number;
  };
};

export interface Retrieval {
  search(req: RetrievalRequestInternal): Promise<RetrievalResponse>;
}
