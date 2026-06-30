/**
 * Backlink boost (port of GBrain `applyBacklinkBoost`).
 *
 * Multiplies a chunk's fused score by `1 + COEF · log(1 + n)` where
 * `n` is the number of *inbound* edges to that chunk via the
 * graph layer. Two backlink signals compose:
 *
 *  - **Wikilink inbound count** — chunks that explicitly reference
 *    the chunk via `[[slug]]`. Strongest signal; most-cited memory
 *    survives the top-K cut.
 *  - **Entity-popularity proxy** — chunks that mention an entity
 *    referenced widely in the corpus. A weaker signal but always
 *    present even before wikilinks land in the extractor output.
 *
 * Both are cheap: wikilink counts come from one batched SQL
 * `inboundCounts` query; entity popularity is in-memory on the
 * EntityIndex. No N+1 fan-out per result.
 *
 * Coefficient calibration follows GBrain (0.05): 1 backlink ≈ +3.5%,
 * 10 backlinks ≈ +12%, 100 backlinks ≈ +23%. Strong enough to flip
 * the top of top-K when a heavily-cited fact surfaces alongside an
 * isolated one; mild enough not to displace correct hits when the
 * graph is sparse.
 */

export const BACKLINK_BOOST_COEF = 0.05;

export type Hit = { score: number };

/**
 * Apply backlink boost to retrieval hits in place. `count` is the
 * combined inbound-edge count for the chunk; pass 0 for chunks with
 * no inbound references (no-op).
 */
export function applyBacklinkBoostFor(hit: Hit, count: number): void {
  if (count <= 0) return;
  hit.score *= 1 + BACKLINK_BOOST_COEF * Math.log(1 + count);
}

export function applyBacklinkBoost<T extends Hit>(
  hits: readonly T[],
  countFor: (hit: T) => number,
): void {
  for (const h of hits) applyBacklinkBoostFor(h, countFor(h));
}
