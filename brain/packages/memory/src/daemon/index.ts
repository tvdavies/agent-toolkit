export { type CycleProgressEvent, type RunCycleOpts, runCycle } from "./cycle.js";
export { createDedupPhase, type DedupPhaseOpts } from "./phases/dedup.js";
export { linkFixPhase } from "./phases/link-fix.js";
export {
  type AtomicMemoryCandidate,
  type AtomicMemoryInput,
  createMemorySynthesizePhase,
  type MemorySynthesizeGenerator,
  type MemorySynthesizePhaseOpts,
} from "./phases/memory-synthesize.js";
export {
  createPatternsPhase,
  type PatternsGenerator,
  type PatternsPhaseOpts,
  type ReflectionInput,
} from "./phases/patterns.js";
export { createStalePhase, type StalePhaseOpts } from "./phases/stale.js";
export {
  createReflectPhase,
  createSynthesizePhase,
  type SynthesizeGenerator,
  type SynthesizeOutput,
  type SynthesizePhaseOpts,
  type TranscriptInput,
} from "./phases/synthesize.js";
export type {
  CycleReport,
  Phase,
  PhaseContext,
  PhaseResult,
  PhaseStatus,
} from "./types.js";
