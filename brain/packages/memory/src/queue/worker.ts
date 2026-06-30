/**
 * Queue worker. The daemon calls `drainOnce` every tick (~500ms by
 * default). Each call claims a small batch from the queue, runs the
 * slow writer chain via `memory.processQueuedItem`, and acks the
 * batch on success or fails it (with retry/backoff handled by the
 * queue layer) on error.
 *
 * Kept as a plain function rather than wrapped in the dream-cycle
 * `Phase` type because queue-drain has no cooldown semantics: it
 * runs every tick, succeeds quickly when the queue is empty, and
 * doesn't share state with the maintenance phases.
 */

import { claim } from "./queue.js";
import type { QueueItem } from "./types.js";

/**
 * Minimal Memory surface the worker needs. Not the full `Memory`
 * interface so tests can stub with a hand-rolled object.
 */
export type QueueProcessor = {
  processQueuedItem(item: QueueItem): Promise<void>;
};

export type DrainOnceOptions = {
  /** Memory the worker hands queued events to. Must match the queued scope. */
  readonly memory: QueueProcessor;
  readonly homeDir: string;
  /** Optional scope filter. Useful when one daemon walks multiple brains. */
  readonly scope?: string;
  /** Maximum items pulled per call. Default 16. */
  readonly maxItems?: number;
  /** Retry budget per item. Default 3, matches the queue default. */
  readonly maxAttempts?: number;
  /** Optional logger; called once per drain with a summary. */
  readonly log?: (msg: string) => void;
};

export type DrainResult = {
  /** Items successfully processed this tick (will be 0 when the queue is empty). */
  processed: number;
  /** Items that errored and got requeued or moved to failed/. */
  errored: number;
};

const DEFAULT_BATCH = 16;

/**
 * Pull one batch of queued items, run the slow writer chain on each,
 * and ack/fail the batch as a whole. Errors during processing fail
 * the entire batch so the queue layer's retry/backoff handles them
 * uniformly; this is fine because the writer pipeline is idempotent
 * via the content-addressed fact and observation caches.
 *
 * Returns 0/0 when the queue is empty so callers can decide whether
 * to back off (sleep the tick) or run another cycle immediately.
 */
export async function drainOnce(opts: DrainOnceOptions): Promise<DrainResult> {
  const claimResult = await claim({
    homeDir: opts.homeDir,
    maxItems: opts.maxItems ?? DEFAULT_BATCH,
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  });
  if (claimResult === null) return { processed: 0, errored: 0 };

  let processed = 0;
  let errored = 0;
  let failure: Error | null = null;
  for (const item of claimResult.items) {
    try {
      await opts.memory.processQueuedItem(item);
      processed++;
    } catch (err) {
      errored++;
      failure = err instanceof Error ? err : new Error(String(err));
      // Stop on first error; the rest of the batch will be requeued
      // by `claim.fail()` along with this one. Cleaner than partial
      // ack semantics and keeps the writer-chain side effects from
      // diverging from the queue state.
      break;
    }
  }

  if (failure !== null) {
    await claimResult.fail(failure);
    opts.log?.(
      `drainOnce: batch failed (${errored}/${claimResult.items.length}): ${failure.message}`,
    );
  } else {
    await claimResult.ack();
    opts.log?.(`drainOnce: processed ${processed} item(s)`);
  }

  return { processed, errored };
}

/**
 * Run `drainOnce` repeatedly until the queue stays empty for one tick.
 * Used by `brain daemon flush` and by tests that want to wait for the
 * worker to catch up without sleeping arbitrarily.
 */
export async function drainUntilEmpty(opts: DrainOnceOptions): Promise<DrainResult> {
  let processed = 0;
  let errored = 0;
  for (;;) {
    const r = await drainOnce(opts);
    processed += r.processed;
    errored += r.errored;
    if (r.processed === 0 && r.errored === 0) return { processed, errored };
  }
}
