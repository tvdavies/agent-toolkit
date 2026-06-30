/**
 * Reciprocal Rank Fusion. Score = sum over lists of weight / (k + rank).
 * `k=60` is the canonical default from Cormack et al. 2009 — also what
 * Jeff's hybrid retrieval uses.
 *
 * The unweighted form (all weights = 1) is the textbook RRF. Weighted
 * form lets callers tilt the fusion based on query intent — see
 * `intent.ts` and `hybrid.ts`.
 */

export const RRF_DEFAULT_K = 60;

export type RRFCandidate<T> = {
  id: string;
  rank: number; // 0-indexed
  source: T;
};

export type RRFList<T> = {
  candidates: readonly RRFCandidate<T>[];
  /** Per-list weight. Defaults to 1.0. Set to 0 to drop the list entirely. */
  weight?: number;
};

export type RRFResult<T> = {
  id: string;
  score: number;
  contributions: T[];
};

/**
 * Fuse multiple ranked lists. Items are matched by `id`; weighted
 * scores accumulate across lists. Lists with `weight: 0` are skipped.
 */
export function reciprocalRankFusion<T>(
  lists: readonly RRFList<T>[],
  k = RRF_DEFAULT_K,
): RRFResult<T>[] {
  const acc = new Map<string, RRFResult<T>>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    if (weight === 0) continue;
    for (const candidate of list.candidates) {
      const contribution = weight / (k + candidate.rank + 1);
      const existing = acc.get(candidate.id);
      if (existing) {
        existing.score += contribution;
        existing.contributions.push(candidate.source);
      } else {
        acc.set(candidate.id, {
          id: candidate.id,
          score: contribution,
          contributions: [candidate.source],
        });
      }
    }
  }
  return Array.from(acc.values()).sort((a, b) => b.score - a.score);
}
