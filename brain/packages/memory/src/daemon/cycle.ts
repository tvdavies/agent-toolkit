/**
 * Cycle orchestrator. Runs the configured phases in order, each
 * gated by:
 *   1. **Cooldown**: skip if `last_run_at + cooldownMs > now`.
 *   2. **Lock**: skip if another run holds `in_progress_run_id`.
 *   3. **Self-consumption guard** (per-phase concern): skip
 *      pages tagged with `daemon-emitted` so synthesise/patterns
 *      don't recurse. Phases handle this internally.
 *
 * Lock acquisition is best-effort: if we observe `in_progress_run_id`
 * set on entry, we skip; on success we write our own runId. A run
 * that crashes leaves the lock dangling — pick it up on the next
 * cycle by stamping `lastRunAt` on entry (the cooldown then naturally
 * blocks immediate re-runs while the human investigates).
 */

import { nanoid } from "nanoid";
import type { CycleReport, Phase, PhaseContext, PhaseResult } from "./types.js";

export type CycleProgressEvent =
  | { type: "cycle-start"; runId: string; phaseCount: number }
  | { type: "phase-start"; runId: string; phase: string; index: number; total: number }
  | { type: "phase-end"; runId: string; result: PhaseResult; index: number; total: number }
  | { type: "cycle-end"; runId: string; report: CycleReport };

export type RunCycleOpts = {
  context: Omit<PhaseContext, "runId">;
  phases: readonly Phase[];
  /** Ignore phase cooldown gates. Useful after fixing a failed/manual run. */
  force?: boolean;
  onProgress?: (event: CycleProgressEvent) => void;
};

export async function runCycle(opts: RunCycleOpts): Promise<CycleReport> {
  const runId = nanoid(10);
  const startedAt = opts.context.now();
  const phases: PhaseResult[] = [];
  opts.onProgress?.({ type: "cycle-start", runId, phaseCount: opts.phases.length });
  for (let i = 0; i < opts.phases.length; i++) {
    const phase = opts.phases[i];
    if (phase === undefined) continue;
    opts.onProgress?.({
      type: "phase-start",
      runId,
      phase: phase.name,
      index: i,
      total: opts.phases.length,
    });
    const result = await runPhase(phase, { ...opts.context, runId }, opts.force === true);
    phases.push(result);
    opts.onProgress?.({ type: "phase-end", runId, result, index: i, total: opts.phases.length });
  }
  const report = { runId, startedAt, endedAt: opts.context.now(), phases };
  opts.onProgress?.({ type: "cycle-end", runId, report });
  return report;
}

async function runPhase(phase: Phase, ctx: PhaseContext, force = false): Promise<PhaseResult> {
  const t0 = ctx.now();
  const state = ctx.storage.getDaemonState(phase.name);

  // Cooldown gate.
  if (
    !ctx.dryRun &&
    state?.lastRunAt !== undefined &&
    phase.cooldownMs > 0 &&
    !force &&
    ctx.now() - state.lastRunAt < phase.cooldownMs
  ) {
    const remainingMs = phase.cooldownMs - (ctx.now() - state.lastRunAt);
    return {
      phase: phase.name,
      status: "skipped",
      message: `cooldown_active (${formatDuration(remainingMs)} remaining; use --force to run now)`,
      durationMs: ctx.now() - t0,
    };
  }

  // Lock gate.
  if (state?.inProgressRunId !== undefined && state.inProgressRunId !== ctx.runId) {
    return {
      phase: phase.name,
      status: "skipped",
      message: `lock_held_by_${state.inProgressRunId}`,
      durationMs: ctx.now() - t0,
    };
  }

  if (!ctx.dryRun) {
    ctx.storage.setDaemonState({ phase: phase.name, inProgressRunId: ctx.runId });
  }

  let result: PhaseResult;
  try {
    result = await phase.run(ctx);
  } catch (err) {
    result = {
      phase: phase.name,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
      durationMs: ctx.now() - t0,
    };
  }

  if (!ctx.dryRun) {
    ctx.storage.setDaemonState({
      phase: phase.name,
      ...(result.status === "ok" ? { lastRunAt: ctx.now() } : {}),
      lastStatus: result.status,
      ...(result.status === "failed" && result.message ? { lastError: result.message } : {}),
      // Clear the lock by writing undefined.
    });
  }
  return result;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
