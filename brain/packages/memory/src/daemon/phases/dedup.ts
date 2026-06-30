/**
 * Dedup phase. Walks live chunks, computes pairwise cosine
 * similarity over their stored embeddings, and for any pair above
 * the threshold:
 *
 *   1. Picks the older chunk as the loser (by created_at; tie →
 *      higher ordinal).
 *   2. Emits a `superseded_by` edge from loser → winner.
 *   3. Soft-deletes the loser (uses the recovery window from #8 so
 *      mistakes are reversible).
 *
 * Naive O(n²) scan suffices for v1 — even a few thousand chunks
 * runs in <1s in pure JS. When the corpus grows past that we'll
 * switch to an HNSW-driven near-duplicate query.
 *
 * Self-consumption guard: aggregates and observations are skipped
 * (their entire job is to be similar to underlying facts; we don't
 * want them deduping each other or the facts they cover).
 */

import { cosineSimilarity } from "../../retrieval/cosine-rescore.js";
import type { Edge } from "../../storage/sqlite.js";
import type { Phase, PhaseResult } from "../types.js";

const DEFAULT_SIMILARITY_THRESHOLD = 0.92;
// Skip categories whose semantic role is to overlap with other facts.
const SKIP_TYPES = new Set(["aggregates", "observations", "episodic"]);

export type DedupPhaseOpts = {
  similarityThreshold?: number;
};

export function createDedupPhase(opts: DedupPhaseOpts = {}): Phase {
  const threshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  return {
    name: "dedup",
    cooldownMs: 0,
    async run(ctx) {
      const t0 = ctx.now();
      const candidates = ctx.storage.listLiveChunks().filter((c) => !SKIP_TYPES.has(c.type));
      if (candidates.length < 2) {
        return phaseOk("dedup", "no_candidates", { duplicates: 0 }, ctx.now() - t0);
      }

      // Hydrate embeddings up front so the inner loop stays in JS.
      const withEmbeddings: Array<{ id: string; type: string; embedding: Float32Array }> = [];
      for (const c of candidates) {
        const e = ctx.storage.getEmbedding(c.id);
        if (e !== undefined) withEmbeddings.push({ id: c.id, type: c.type, embedding: e });
      }
      if (withEmbeddings.length < 2) {
        return phaseOk("dedup", "no_embeddings", { duplicates: 0 }, ctx.now() - t0);
      }

      const losers = new Set<string>();
      const newEdges: Edge[] = [];
      for (let i = 0; i < withEmbeddings.length; i++) {
        const a = withEmbeddings[i];
        if (a === undefined || losers.has(a.id)) continue;
        for (let j = i + 1; j < withEmbeddings.length; j++) {
          const b = withEmbeddings[j];
          if (b === undefined || losers.has(b.id)) continue;
          if (a.type !== b.type) continue;
          const sim = cosineSimilarity(a.embedding, b.embedding);
          if (sim < threshold) continue;
          // Loser by deterministic-tiebreak: lex smaller id wins
          // (cheap proxy for "earlier" without needing created_at
          // ordering and stable across runs).
          const winnerId = a.id < b.id ? a.id : b.id;
          const loserId = a.id < b.id ? b.id : a.id;
          losers.add(loserId);
          newEdges.push({
            fromChunkId: loserId,
            toChunkId: winnerId,
            linkType: "superseded_by",
            context: `dedup similarity ${sim.toFixed(3)}`,
            linkSource: "manual",
            originChunkId: loserId,
          });
        }
      }

      if (!ctx.dryRun) {
        if (newEdges.length > 0) ctx.storage.upsertEdges(newEdges);
        for (const id of losers) ctx.storage.archiveChunk(id);
      }

      return phaseOk(
        "dedup",
        `archived ${losers.size} duplicates (threshold ${threshold})`,
        { duplicates: losers.size, edges: newEdges.length, threshold },
        ctx.now() - t0,
      );
    },
  };
}

function phaseOk(
  phase: string,
  message: string,
  stats: Record<string, unknown>,
  durationMs: number,
): PhaseResult {
  return { phase, status: "ok", message, stats, durationMs };
}
