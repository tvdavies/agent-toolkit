/**
 * Durable, on-disk write queue for memory events.
 *
 * The CLI's `brain add` / `brain remember` commands enqueue events that
 * need expensive post-processing (extraction, observation, embedding,
 * consolidation, graph edges) and return immediately. A daemon worker
 * drains the queue in the background and runs the slow writer chain.
 *
 * Verbatim chunks are persisted synchronously by the caller before
 * enqueueing so BM25 retrieval works on freshly-recorded events even
 * while the queue is still pending.
 *
 * Layout under `<homeDir>/queue/`:
 *   - `pending/<ts>-<id>.json`    enqueued, waiting to be processed
 *   - `in-flight/<ts>-<id>.json`  claimed by a worker, mid-processing
 *   - `failed/<ts>-<id>.json`     retried `maxAttempts` times and gave up
 *
 * Concurrency is owned by atomic POSIX rename: claim moves a file from
 * `pending/` to `in-flight/` and only the worker that wins the rename
 * race processes it. No flock, no lockfiles.
 */
import type { MemoryEvent } from "@ai-assistant/contracts";

/**
 * A single queued write. Persisted as one JSON file under the queue
 * directory; the filename encodes both an ISO timestamp prefix (for
 * lexicographic ordering) and a nanoid suffix (for uniqueness across
 * concurrent writers in the same millisecond).
 */
export type QueueItem = {
  /** Unique id, also embedded in the filename. */
  readonly id: string;
  /** Scope the event belongs to. The worker opens the matching brain. */
  readonly scope: string;
  /** ISO-8601 timestamp the item was enqueued. */
  readonly enqueuedAt: string;
  /** The event the writer chain will consume. */
  readonly event: MemoryEvent;
  /** How many times processing has been attempted so far (0 on first claim). */
  readonly attempts: number;
};

/**
 * A live claim on a batch of items. The worker calls `ack()` after a
 * successful run (which deletes the in-flight files) or `fail(error)`
 * after `maxAttempts` retries (which moves them to `failed/`). If the
 * worker crashes, the files stay in `in-flight/` and the daemon's
 * recovery sweep on next startup re-queues them.
 */
export type QueueClaim = {
  readonly items: readonly QueueItem[];
  /** Mark the batch as successfully processed; deletes the in-flight files. */
  ack(): Promise<void>;
  /**
   * Mark the batch as failed for this attempt. If `attempts + 1 >= maxAttempts`,
   * items move to `failed/` with the error attached. Otherwise they go back
   * to `pending/` with `attempts` incremented for a later retry.
   */
  fail(error: Error): Promise<void>;
};

/**
 * Stats for `brain daemon status` and the auto-warning printed by
 * `brain add` when the queue grows past a threshold without a daemon
 * draining it.
 */
export type QueueStats = {
  readonly pending: number;
  readonly inFlight: number;
  readonly failed: number;
};
