/**
 * Cosine re-score after RRF (port of GBrain's cosineReScore).
 *
 * After RRF fuses keyword + vector candidate lists, blend the fused
 * score with the per-chunk cosine-similarity score the vector pass
 * already produced:
 *
 *   score = RRF_WEIGHT · rrf_score + COSINE_WEIGHT · vector_score
 *
 * Vector_score is `max(0, 1 - L2/√2)` — a cosine-similarity-like
 * value in [0, 1]. Keyword-only hits (no vector contribution) blend
 * with 0 and effectively keep their RRF score scaled by RRF_WEIGHT;
 * since every hit gets the same reduction the relative ordering is
 * unchanged for keyword-only candidates.
 *
 * The lift comes from semantically-strong candidates whose RRF rank
 * was hurt by missing keywords. We pay nothing extra — vector_score
 * is already on the hit's contributions map from the RRF builder.
 */

export const COSINE_RESCORE_RRF_WEIGHT = 0.7;
export const COSINE_RESCORE_COSINE_WEIGHT = 0.3;

export type Rescorable = {
  score: number;
  contributions?: { vector?: number };
};

/** Blend in place. Mutates `hit.score`. */
export function applyCosineRescore<T extends Rescorable>(hits: readonly T[]): void {
  for (const hit of hits) {
    const vec = hit.contributions?.vector ?? 0;
    hit.score =
      COSINE_RESCORE_RRF_WEIGHT * hit.score + COSINE_RESCORE_COSINE_WEIGHT * Math.max(0, vec);
  }
}

/**
 * Pure-JS cosine similarity for two equally-sized Float32Arrays.
 * Used by the daemon's dedup phase; the retrieval-time blend reads
 * the precomputed vector contribution from the RRF fuser instead.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
