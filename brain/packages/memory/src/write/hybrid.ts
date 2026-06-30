import type { Writer, WrittenChunk } from "./types.js";

/**
 * Composes multiple writers over the same event buffer. Each sub-writer
 * receives the full buffer and the same `baseOrdinal`; their outputs are
 * concatenated. Sub-writers are expected to use distinct path prefixes
 * (e.g. `episodic/` for verbatim, `user-fact-`/`milestone-` for
 * extraction) so paths don't collide. Chunk ids are assigned by the
 * Memory layer, so id collisions can't happen here.
 *
 * Why bother: extraction-only writes lose literal facts (M2.p showed
 * single-session-assistant collapse 6/6 → 1/6 because the extractor
 * paraphrased exact dosages, budgets, names away). Verbatim-only writes
 * leave path-conventional retrieval multipliers idle. Storing both gives
 * retrieval a typed-fact path *and* a literal-detail safety net — the
 * design pattern Jeff and Mastra both use.
 *
 * Ordering of writers is preserved in the output. With the standard
 * `[verbatim, extraction]` pairing this means episodic chunks appear
 * first in the upsert batch, but order is irrelevant to retrieval.
 */
export function createHybridWriter(writers: readonly Writer[]): Writer {
  return {
    async process(events, baseOrdinal, context): Promise<WrittenChunk[]> {
      if (events.length === 0) return [];
      const results = await Promise.all(
        writers.map((w) => w.process(events, baseOrdinal, context)),
      );
      return results.flat();
    },
  };
}

export const HYBRID_WRITER_ID = "hybrid";
