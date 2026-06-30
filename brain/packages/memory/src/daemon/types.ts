/**
 * Dream-cycle daemon types.
 *
 * Each phase is a function that takes a `PhaseContext` (storage,
 * markdown store, optional LLM access) and returns a `PhaseResult`.
 * The orchestrator (cycle.ts) runs phases in order, each gated by a
 * cooldown timer and an in-progress lock so concurrent runs back
 * off rather than racing.
 *
 * Status values mirror GBrain's vocabulary: ok | skipped | failed.
 * Skipped is reserved for "phase deliberately did nothing this run"
 * (cooldown active, nothing to process); failed is for actual errors.
 */

import type { MarkdownStore } from "../storage/markdown-store.js";
import type { Storage } from "../storage/sqlite.js";

export type PhaseStatus = "ok" | "skipped" | "failed";

export type PhaseResult = {
  phase: string;
  status: PhaseStatus;
  /** Human-readable message; "skipped: cooldown_active" etc. */
  message?: string;
  /** Phase-specific stats. */
  stats?: Record<string, unknown>;
  /** Wall-clock duration in ms. */
  durationMs: number;
};

export type PhaseContext = {
  storage: Storage;
  markdownStore: MarkdownStore;
  /** Identifies this cycle run for log + lock attribution. */
  runId: string;
  /** When true, phases compute but don't write. */
  dryRun: boolean;
  /** Now-getter (injectable for tests). */
  now: () => number;
};

export type Phase = {
  name: string;
  /**
   * Cooldown between successful runs in ms. Failed and skipped
   * phases don't count as a run for cooldown purposes — the next
   * cycle reattempts immediately. 0 = no cooldown.
   */
  cooldownMs: number;
  run(ctx: PhaseContext): Promise<PhaseResult>;
};

export type CycleReport = {
  runId: string;
  startedAt: number;
  endedAt: number;
  phases: PhaseResult[];
};
