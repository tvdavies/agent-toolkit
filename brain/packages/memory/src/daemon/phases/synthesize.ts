/**
 * Synthesise phase (skeleton).
 *
 * Reads recent conversation transcripts, asks an LLM to surface
 * what's worth promoting to a brain page, then writes the new
 * pages into the markdown store. Mirrors GBrain's synthesise phase
 * but synchronous (no subagent fan-out for v1).
 *
 * The LLM call is injected so this module stays cheap to test;
 * production callers wire in a real generator. v1 leaves the
 * verdict-cache + cooldown + self-consumption guard scaffolded but
 * the synthesis logic itself is a stub that exits with a
 * "not_configured" skipped result when no generator is supplied —
 * we want to land the framework now and iterate the LLM body when
 * we have transcripts to feed it.
 */

import type { Phase, PhaseContext } from "../types.js";

export type SynthesizeGenerator = (input: {
  transcripts: readonly TranscriptInput[];
  ctx: PhaseContext;
}) => Promise<SynthesizeOutput>;

export type TranscriptInput = {
  id: string;
  body: string;
  recordedAt?: string;
};

export type SynthesizeOutput = {
  pagesWritten: number;
  message?: string;
};

export type SynthesizePhaseOpts = {
  /**
   * Source of recent transcripts (caller provides; the daemon
   * doesn't dictate where conversations live). Empty array →
   * phase skips with `no_transcripts`.
   */
  loadRecentTranscripts: (ctx: PhaseContext) => Promise<TranscriptInput[]>;
  /**
   * The LLM call that does the synthesis. Omitting it makes the
   * phase a no-op (skipped: not_configured) — useful for cycles
   * where you want the rest to run but haven't wired the model yet.
   */
  generate?: SynthesizeGenerator;
  /** Default 6 hours so a per-day cron isn't blocked by manual runs. */
  cooldownMs?: number;
};

export function createReflectPhase(opts: SynthesizePhaseOpts): Phase {
  return {
    name: "reflect",
    cooldownMs: opts.cooldownMs ?? 6 * 60 * 60 * 1000,
    async run(ctx) {
      const t0 = ctx.now();
      if (opts.generate === undefined) {
        return {
          phase: "reflect",
          status: "skipped",
          message: "not_configured",
          durationMs: ctx.now() - t0,
        };
      }
      const transcripts = await opts.loadRecentTranscripts(ctx);
      if (transcripts.length === 0) {
        return {
          phase: "reflect",
          status: "skipped",
          message: "no_transcripts",
          durationMs: ctx.now() - t0,
        };
      }
      const out = await opts.generate({ transcripts, ctx });
      return {
        phase: "reflect",
        status: "ok",
        message: out.message ?? `wrote ${out.pagesWritten} pages`,
        stats: { pagesWritten: out.pagesWritten, transcriptsConsidered: transcripts.length },
        durationMs: ctx.now() - t0,
      };
    },
  };
}

/** @deprecated Use createReflectPhase. This old name produced reflections, not atomic memories. */
export const createSynthesizePhase = createReflectPhase;
