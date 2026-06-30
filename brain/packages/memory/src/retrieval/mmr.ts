/**
 * Maximal Marginal Relevance — picks top-K from a candidate list
 * balancing relevance with diversity from already-picked items.
 *
 * Standard MMR: at each step pick the candidate that maximises
 *   λ * relevance - (1 - λ) * max_similarity_to_picked
 *
 * Targets the failure mode where 3 of top-5 are near-duplicates of one
 * event, crowding out other relevant events. Helps multi-session
 * counting questions where the actor needs to see DIFFERENT events.
 *
 * Similarity here is a cheap token-overlap (Jaccard on lower-cased
 * word tokens). Good enough to detect "same event paraphrased
 * differently" without requiring an extra embedding call per pair.
 */

import type { RetrievalHit } from "./types.js";

const DEFAULT_LAMBDA = 0.6;

/**
 * Pick top-K via MMR. Higher `lambda` weights relevance; lower weights
 * diversity. Default 0.6 leans relevance but rejects near-duplicates.
 */
export function selectMMR(
  hits: readonly RetrievalHit[],
  topK: number,
  lambda: number = DEFAULT_LAMBDA,
): RetrievalHit[] {
  if (hits.length <= topK) return [...hits];
  const remaining = [...hits];
  const picked: RetrievalHit[] = [];
  // Pre-tokenise once.
  const tokens = new Map<string, Set<string>>();
  for (const h of remaining) tokens.set(h.chunk.id, tokenise(h.chunk.content));

  // First pick is just the highest-score candidate.
  remaining.sort((a, b) => b.score - a.score);
  const first = remaining.shift();
  if (first === undefined) return picked;
  picked.push(first);

  while (picked.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      if (cand === undefined) continue;
      const candTokens = tokens.get(cand.chunk.id);
      if (candTokens === undefined) continue;
      let maxSim = 0;
      for (const p of picked) {
        const pTokens = tokens.get(p.chunk.id);
        if (pTokens === undefined) continue;
        const sim = jaccard(candTokens, pTokens);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * cand.score - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    if (next === undefined) break;
    picked.push(next);
  }

  return picked;
}

function tokenise(s: string): Set<string> {
  const tokens = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3) tokens.add(t);
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
