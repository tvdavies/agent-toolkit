import type { WrittenChunk } from "../write/types.js";

/**
 * Write-time consolidation. After the writer produces per-fact chunks,
 * the consolidator (if configured) takes them and emits a smaller set of
 * **aggregate chunks** that pre-compute the kinds of summaries the
 * actor would otherwise have to derive at retrieval time.
 *
 * Targets multi-session counting/totalling questions. Without this:
 *
 *   Q: "How many weddings did I attend this year?"
 *   chunks (top-5): "attended Sarah's wedding", "attended Mike's", ...
 *   actor: answers based on what's surfaced, easily off-by-one.
 *
 * With aggregates:
 *
 *   Q: "How many weddings did I attend this year?"
 *   aggregate-wedding-N.md: "user attended 4 weddings in 2024:
 *                           Sarah/Mike (Mar), Lisa/James (Jun), ...".
 *   chunks (top-5): the aggregate + 4 underlying events.
 *   actor: reads the aggregate, answers 4.
 *
 * The aggregate chunk lives at a `aggregate-*` path so retrieval-side
 * intent multipliers can boost it on factoid/counting queries.
 */
export interface Consolidator {
  /**
   * Process chunks from a single flush. Returns aggregate chunks (with
   * `aggregate-*` paths) to be stored alongside the original chunks.
   * `baseOrdinal` is the ordinal to start assigning to aggregates from
   * — the consolidator is responsible for not colliding with existing
   * paths/ordinals (the writer's chunks).
   */
  consolidate(chunks: readonly WrittenChunk[], baseOrdinal: number): Promise<WrittenChunk[]>;
}
