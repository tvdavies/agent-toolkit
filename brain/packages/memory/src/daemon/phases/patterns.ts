/**
 * Patterns phase (skeleton).
 *
 * Cross-session theme detection. Reads recent reflections (synthesise
 * output) within a lookback window, asks an LLM to surface themes
 * that recur across ≥ minEvidence distinct reflections, and writes
 * one pattern page per theme. Mirrors GBrain's patterns phase.
 *
 * Skipped when:
 *  - generate is undefined (not_configured),
 *  - reflections in window < minEvidence (insufficient_evidence).
 *
 * Caller injects loadRecentReflections + generate; the daemon owns
 * cooldown + lock + status reporting only.
 */

import type { Phase, PhaseContext } from "../types.js";

export type ReflectionInput = {
  id: string;
  body: string;
  recordedAt?: string;
};

export type PatternsGenerator = (input: {
  reflections: readonly ReflectionInput[];
  ctx: PhaseContext;
}) => Promise<{ patternsWritten: number; message?: string }>;

export type PatternsPhaseOpts = {
  loadRecentReflections: (ctx: PhaseContext) => Promise<ReflectionInput[]>;
  generate?: PatternsGenerator;
  minEvidence?: number;
  /** Default 24h — patterns shouldn't churn intra-day. */
  cooldownMs?: number;
};

export function createPatternsPhase(opts: PatternsPhaseOpts): Phase {
  const minEvidence = opts.minEvidence ?? 3;
  return {
    name: "patterns",
    cooldownMs: opts.cooldownMs ?? 24 * 60 * 60 * 1000,
    async run(ctx) {
      const t0 = ctx.now();
      if (opts.generate === undefined) {
        return {
          phase: "patterns",
          status: "skipped",
          message: "not_configured",
          durationMs: ctx.now() - t0,
        };
      }
      const reflections = await opts.loadRecentReflections(ctx);
      if (reflections.length < minEvidence) {
        return {
          phase: "patterns",
          status: "skipped",
          message: `insufficient_evidence (${reflections.length} < ${minEvidence})`,
          durationMs: ctx.now() - t0,
        };
      }
      const out = await opts.generate({ reflections, ctx });
      return {
        phase: "patterns",
        status: "ok",
        message: out.message ?? `wrote ${out.patternsWritten} patterns`,
        stats: {
          patternsWritten: out.patternsWritten,
          reflectionsConsidered: reflections.length,
        },
        durationMs: ctx.now() - t0,
      };
    },
  };
}
