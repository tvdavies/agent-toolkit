/**
 * Heuristic reranker — local, sub-millisecond, no LLM call.
 *
 * Adds two cross-hit signals on top of the fused RRF score:
 *
 *  1. **Hard near-duplicate suppression.** When a candidate's cosine
 *     similarity to ANY already-selected hit is ≥ `duplicateThreshold`
 *     (default 0.92, matching the dedup phase), drop it. Two embeddings
 *     this close almost certainly carry the same fact. Surfacing both
 *     wastes a slot and dilutes the actor's attention.
 *
 *  2. **Soft MMR for the gray zone.** For cosines in
 *     `[mmrFloor, duplicateThreshold)` (default 0.7-0.92), apply a
 *     gentle penalty: `score *= 1 - mmrLambda * cosineMaxSelected`.
 *     Small enough to preserve the top hit's primacy when it's clearly
 *     the strongest, but enough to break ties in favour of diversity.
 *
 * **What this DOESN'T do** (deliberately):
 *   - No token-overlap scoring. BM25 already captures lexical match
 *     better in the pre-RRF stage.
 *   - No recency boost. Pre-RRF `decayMultiplier` already handles it,
 *     and intent-aware temporal weighting is a different problem.
 *   - No authority re-application. Pre-RRF `authorityMultiplier`
 *     already weighted by pinned/manual/observed levels.
 *   - No semantic understanding of the query against passages — that's
 *     what the LLM cross-encoder reranker is for. Use that when you
 *     need maximum quality on hard queries; this is the everyday path.
 *
 * Hits without embeddings (BM25-only candidates) participate in
 * ranking by their RRF score but contribute no MMR signal — we skip
 * the cosine calculation rather than treating "no embedding" as
 * "infinitely dissimilar."
 *
 * Performance: O(N²) cosine calls in the worst case, where N is
 * `windowK`. With windowK=20 that's 190 dot products on ≤3072-dim
 * vectors — sub-millisecond on any modern CPU.
 */

import { cosineSimilarity } from "./cosine-rescore.js";
import type { Reranker } from "./rerank.js";
import type { RetrievalHit } from "./types.js";

export type HeuristicRerankerOptions = {
  /**
   * Top-N candidates considered. Items beyond this stay in their
   * fused order. Default 20 (matches our gateway reranker).
   */
  readonly windowK?: number;
  /**
   * Cosine threshold above which two hits count as near-duplicates
   * and the lower-ranked one is dropped. Default 0.92, mirroring the
   * dedup phase's threshold for `superseded_by` edges.
   */
  readonly duplicateThreshold?: number;
  /**
   * Lower bound for soft MMR penalty. Cosines below this are treated
   * as "different enough" — no penalty. Default 0.7.
   */
  readonly mmrFloor?: number;
  /**
   * Soft MMR strength. The penalty for a candidate whose max similarity
   * to selected hits is `s` (with `mmrFloor ≤ s < duplicateThreshold`)
   * is `score *= 1 - mmrLambda * s`. Default 0.3 — gentle enough that
   * a clear top hit isn't perturbed.
   */
  readonly mmrLambda?: number;
};

const DEFAULT_WINDOW_K = 20;
const DEFAULT_DUPLICATE_THRESHOLD = 0.92;
const DEFAULT_MMR_FLOOR = 0.7;
const DEFAULT_MMR_LAMBDA = 0.3;

export function createHeuristicReranker(opts: HeuristicRerankerOptions = {}): Reranker {
  const windowK = opts.windowK ?? DEFAULT_WINDOW_K;
  const duplicateThreshold = opts.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD;
  const mmrFloor = opts.mmrFloor ?? DEFAULT_MMR_FLOOR;
  const mmrLambda = opts.mmrLambda ?? DEFAULT_MMR_LAMBDA;

  return {
    async rerank(_query, candidates, topK) {
      if (candidates.length === 0) return [];
      const window = candidates.slice(0, windowK);
      const tail = candidates.slice(windowK);
      if (window.length <= 1) return candidates.slice(0, topK);

      // Greedy selection. Each pick is the highest-scoring remaining
      // candidate AFTER applying the MMR penalty against already-selected.
      // Hard-skip any candidate at cosine >= duplicateThreshold to a
      // selected one.
      const selected: RetrievalHit[] = [];
      const remaining = window.map((hit) => ({ hit, dropped: false }));

      while (selected.length < topK && remaining.some((r) => !r.dropped)) {
        let bestIdx = -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < remaining.length; i++) {
          const cand = remaining[i];
          if (cand === undefined || cand.dropped) continue;
          const sim = maxSimilarityToSelected(cand.hit, selected);
          if (sim >= duplicateThreshold) {
            // Hard near-duplicate: skip permanently.
            cand.dropped = true;
            continue;
          }
          const penalty = sim >= mmrFloor ? 1 - mmrLambda * sim : 1;
          const score = cand.hit.score * penalty;
          if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        }
        if (bestIdx === -1) break;
        const winner = remaining[bestIdx];
        if (winner === undefined) break;
        winner.dropped = true;
        // Stamp the rerank-adjusted score on the hit so callers see it.
        selected.push({ ...winner.hit, score: bestScore });
      }

      // The window may have produced fewer than topK selections (heavy
      // deduplication). Fill from the tail in fused order.
      const out: RetrievalHit[] = [...selected];
      if (out.length < topK) {
        for (const t of tail) {
          out.push(t);
          if (out.length >= topK) break;
        }
      }
      return out.slice(0, topK);
    },
  };
}

/**
 * Max cosine of `candidate` against any chunk in `selected`. Returns 0
 * when either side lacks an embedding (treated as "no signal" — neither
 * helpful nor harmful for the candidate).
 */
function maxSimilarityToSelected(
  candidate: RetrievalHit,
  selected: readonly RetrievalHit[],
): number {
  const a = candidate.chunk.embedding;
  if (a === undefined) return 0;
  let max = 0;
  for (const s of selected) {
    const b = s.chunk.embedding;
    if (b === undefined) continue;
    if (a.length !== b.length) continue; // mixed-dim corpora — no comparison
    const sim = cosineSimilarity(a, b);
    if (sim > max) max = sim;
  }
  return max;
}
