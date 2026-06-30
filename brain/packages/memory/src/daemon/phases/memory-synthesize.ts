import type { MemoryType } from "../../storage/markdown-store.js";
import type { Phase, PhaseContext } from "../types.js";
import type { ReflectionInput } from "./patterns.js";
import type { TranscriptInput } from "./synthesize.js";

export type AtomicMemoryInput = {
  id: string;
  body: string;
  recordedAt?: string;
  sourceType: "raw" | "reflection";
  /** Generic source envelope from connectors. Kept unknown here so core doesn't need connector schemas. */
  envelope?: Record<string, unknown>;
};

export type AtomicMemoryCandidate = {
  type: Extract<
    MemoryType,
    "facts" | "preferences" | "events" | "decisions" | "context" | "observations"
  >;
  content: string;
  entities: string[];
  confidence: number;
  provenance: {
    sourceIds: string[];
    sourceTypes: string[];
    derivation:
      | "user-stated"
      | "assistant-inferred"
      | "tool-observed"
      | "reflection-derived"
      | "mixed";
  };
};

export type MemorySynthesizeGenerator = (input: {
  inputs: readonly AtomicMemoryInput[];
  ctx: PhaseContext;
}) => Promise<{ memoriesWritten: number; message?: string }>;

export type MemorySynthesizePhaseOpts = {
  loadRecentTranscripts: (ctx: PhaseContext) => Promise<TranscriptInput[]>;
  loadRecentReflections: (ctx: PhaseContext) => Promise<ReflectionInput[]>;
  loadRecentSourceInputs?: (ctx: PhaseContext) => Promise<AtomicMemoryInput[]>;
  generate?: MemorySynthesizeGenerator;
  cooldownMs?: number;
};

export function createMemorySynthesizePhase(opts: MemorySynthesizePhaseOpts): Phase {
  return {
    name: "synthesize",
    cooldownMs: opts.cooldownMs ?? 6 * 60 * 60 * 1000,
    async run(ctx) {
      const t0 = ctx.now();
      if (opts.generate === undefined) {
        return {
          phase: "synthesize",
          status: "skipped",
          message: "not_configured",
          durationMs: ctx.now() - t0,
        };
      }
      const [transcripts, reflections, sourceInputs] = await Promise.all([
        opts.loadRecentTranscripts(ctx),
        opts.loadRecentReflections(ctx),
        opts.loadRecentSourceInputs?.(ctx) ?? Promise.resolve([]),
      ]);
      const inputs: AtomicMemoryInput[] = [
        ...sourceInputs,
        ...transcripts.map((t) => ({
          id: t.id,
          body: t.body,
          recordedAt: t.recordedAt,
          sourceType: "raw" as const,
        })),
        ...reflections.map((r) => ({
          id: r.id,
          body: r.body,
          recordedAt: r.recordedAt,
          sourceType: "reflection" as const,
        })),
      ];
      if (inputs.length === 0) {
        return {
          phase: "synthesize",
          status: "skipped",
          message: "no_inputs",
          durationMs: ctx.now() - t0,
        };
      }
      const out = await opts.generate({ inputs, ctx });
      return {
        phase: "synthesize",
        status: "ok",
        message: out.message ?? `wrote ${out.memoriesWritten} atomic memories`,
        stats: { memoriesWritten: out.memoriesWritten, inputsConsidered: inputs.length },
        durationMs: ctx.now() - t0,
      };
    },
  };
}
