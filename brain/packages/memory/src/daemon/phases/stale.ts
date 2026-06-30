/**
 * Stale phase. Soft-deletes chunks that look orphaned: zero
 * inbound edges, zero outbound edges, AND older than the stale
 * threshold (default: 90 days). The soft-delete uses #8's
 * recovery window so the daemon's mistakes are reversible.
 *
 * Conservative by design — operates only on truly disconnected
 * chunks. Anything wikilinked or referenced via shared entities
 * survives. The threshold + the orphan signal compose: a brand-new
 * orphan is fine (the user just wrote it); a 90-day-old orphan is
 * almost certainly drift the brain doesn't need anymore.
 *
 * Self-consumption guard: episodic chunks (verbatim turn dumps) are
 * never stale — they're deliberately raw. Aggregates / observations
 * are skipped because they're derived; the daemon should clean them
 * up via dedup or rewrite, not stale.
 */

import type { Phase, PhaseResult } from "../types.js";

const DEFAULT_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
const SKIP_TYPES = new Set(["episodic", "aggregates", "observations"]);

export type StalePhaseOpts = {
  staleAfterMs?: number;
};

export function createStalePhase(opts: StalePhaseOpts = {}): Phase {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  return {
    name: "stale",
    cooldownMs: 0,
    async run(ctx) {
      const t0 = ctx.now();
      const chunks = ctx.storage.listLiveChunks().filter((c) => !SKIP_TYPES.has(c.type));
      if (chunks.length === 0) {
        return phaseOk("stale", "no_candidates", { archived: 0 }, ctx.now() - t0);
      }

      // Bulk-fetch inbound counts in one query.
      const inbound = ctx.storage.inboundCounts(chunks.map((c) => c.id));
      const cutoff = ctx.now() - staleAfterMs;

      let archived = 0;
      for (const c of chunks) {
        const meta = c.metadata ?? {};
        const createdAt = typeof meta.createdAt === "number" ? meta.createdAt : undefined;
        // Accept missing created_at as "old" only when explicitly
        // configured? For v1 we err on the side of safety: skip
        // chunks without a created_at.
        if (createdAt === undefined || createdAt > cutoff) continue;
        if ((inbound.get(c.id) ?? 0) > 0) continue;
        const outbound = ctx.storage.outboundEdges(c.id);
        if (outbound.length > 0) continue;
        if (!ctx.dryRun) ctx.storage.archiveChunk(c.id);
        archived++;
      }

      return phaseOk(
        "stale",
        `archived ${archived} orphans older than ${Math.round(staleAfterMs / 86400000)}d`,
        { archived, threshold: staleAfterMs },
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
