/**
 * Directory-based write queue. See `./types.ts` for the on-disk layout.
 *
 * Concurrency model: each item is a single JSON file; transitions
 * between states (pending → in-flight → ack/fail) use atomic POSIX
 * `rename(2)`. A claim races concurrent workers via rename — exactly
 * one worker wins, so no flock or lockfile is needed. A producer's
 * `enqueue` writes a temp file then renames it into `pending/`, so
 * partial writes never appear claimable.
 *
 * Crash recovery: a worker that dies mid-processing leaves files in
 * `in-flight/`. `recoverInFlight()` (called by the daemon on startup)
 * moves them back to `pending/` so the next claim picks them up. The
 * fact cache (content-addressed) makes re-processing cheap when the
 * extractor has already seen the same group.
 */

import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryEvent } from "@ai-assistant/contracts";
import { nanoid } from "nanoid";
import type { QueueClaim, QueueItem, QueueStats } from "./types.js";

const PENDING = "pending";
const IN_FLIGHT = "in-flight";
const FAILED = "failed";

export type QueueOptions = {
  readonly homeDir: string;
};

export type EnqueueOptions = {
  readonly homeDir: string;
  readonly scope: string;
  readonly event: MemoryEvent;
};

export type ClaimOptions = {
  readonly homeDir: string;
  readonly maxItems: number;
  /**
   * Maximum attempts before moving to `failed/`. Default 3. The
   * counter starts at 0 on first enqueue and is incremented when an
   * item is requeued via `fail()` for a transient error.
   */
  readonly maxAttempts?: number;
  /** Optional scope filter; when set, only items for this scope are claimed. */
  readonly scope?: string;
};

const DEFAULT_MAX_ATTEMPTS = 3;

/** Ensure the three state directories exist under `<homeDir>/queue/`. */
async function ensureDirs(homeDir: string): Promise<{
  pending: string;
  inFlight: string;
  failed: string;
}> {
  const queueDir = join(homeDir, "queue");
  const pending = join(queueDir, PENDING);
  const inFlight = join(queueDir, IN_FLIGHT);
  const failed = join(queueDir, FAILED);
  await Promise.all([
    mkdir(pending, { recursive: true }),
    mkdir(inFlight, { recursive: true }),
    mkdir(failed, { recursive: true }),
  ]);
  return { pending, inFlight, failed };
}

/**
 * Append-safe filename: ISO timestamp with `:` and `.` swapped for `-`
 * (filesystem-friendly), plus a nanoid suffix so two writers in the
 * same millisecond can't collide.
 */
function makeFilename(enqueuedAt: string, id: string): string {
  const safeTs = enqueuedAt.replace(/[:.]/g, "-");
  return `${safeTs}-${id}.json`;
}

/**
 * Enqueue a single event. Writes to a temp file first then atomically
 * renames into `pending/` so a concurrent reader never sees a partial
 * file. Returns the item that was queued.
 */
export async function enqueue(opts: EnqueueOptions): Promise<QueueItem> {
  const { pending } = await ensureDirs(opts.homeDir);
  const id = nanoid(12);
  const enqueuedAt = new Date().toISOString();
  const item: QueueItem = {
    id,
    scope: opts.scope,
    enqueuedAt,
    event: opts.event,
    attempts: 0,
  };
  const filename = makeFilename(enqueuedAt, id);
  // Temp filename uses `.tmp-` prefix so the directory listing in
  // claim() can skip it if a write is in flight when a worker scans.
  const tmpPath = join(pending, `.tmp-${filename}`);
  const finalPath = join(pending, filename);
  await writeFile(tmpPath, JSON.stringify(item), "utf8");
  await rename(tmpPath, finalPath);
  return item;
}

/**
 * Claim up to `maxItems` items from the pending queue. The claim is
 * atomic per-item: each pending file is renamed into `in-flight/` and
 * only the worker that wins the rename race ends up with it. A
 * concurrent worker that loses the race for one file simply moves on
 * to the next pending entry.
 *
 * Returns `null` when there is nothing to claim. The returned
 * `QueueClaim` carries the parsed items plus `ack` / `fail` handlers
 * the worker calls to finalise the batch.
 */
export async function claim(opts: ClaimOptions): Promise<QueueClaim | null> {
  const { pending, inFlight, failed } = await ensureDirs(opts.homeDir);
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  // Sorted listing means the oldest pending items get claimed first
  // (FIFO). `.tmp-` files are producers mid-write; skip them.
  const entries = (await readdir(pending))
    .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
    .sort();
  if (entries.length === 0) return null;

  const claimed: { item: QueueItem; inFlightPath: string }[] = [];
  for (const filename of entries) {
    if (claimed.length >= opts.maxItems) break;
    const fromPath = join(pending, filename);
    const toPath = join(inFlight, filename);
    try {
      // Atomic. If a concurrent worker already claimed this file the
      // source no longer exists and rename throws — we move on.
      await rename(fromPath, toPath);
    } catch {
      continue;
    }
    let parsed: QueueItem;
    try {
      const text = await Bun.file(toPath).text();
      const raw = JSON.parse(text) as Partial<QueueItem>;
      if (
        typeof raw.id !== "string" ||
        typeof raw.scope !== "string" ||
        typeof raw.enqueuedAt !== "string" ||
        typeof raw.event !== "object" ||
        raw.event === null ||
        typeof raw.attempts !== "number"
      ) {
        throw new Error("malformed queue item");
      }
      parsed = raw as QueueItem;
    } catch (err) {
      // Couldn't parse; quarantine in failed/ so it doesn't poison
      // the queue forever, then move on.
      const errMsg = err instanceof Error ? err.message : String(err);
      const failedPath = join(failed, filename);
      try {
        await rename(toPath, failedPath);
        await writeFile(`${failedPath}.error`, errMsg, "utf8");
      } catch {
        // best-effort
      }
      continue;
    }
    if (opts.scope !== undefined && parsed.scope !== opts.scope) {
      // Wrong scope for this worker — return it to pending. Use a new
      // filename so its position in the queue order is preserved
      // (otherwise it'd jump to the front).
      try {
        await rename(toPath, fromPath);
      } catch {
        // best-effort; if this fails the recovery sweep will catch it.
      }
      continue;
    }
    claimed.push({ item: parsed, inFlightPath: toPath });
  }

  if (claimed.length === 0) return null;

  const items = claimed.map((c) => c.item);
  return {
    items,
    async ack() {
      // Successful run — delete every in-flight file in the batch.
      await Promise.all(
        claimed.map(async (c) => {
          try {
            await rm(c.inFlightPath, { force: true });
          } catch {
            // Already removed by recovery? Ignore.
          }
        }),
      );
    },
    async fail(error: Error) {
      // For each item: if attempts+1 >= maxAttempts, move to failed/
      // with an error sidecar; otherwise rewrite to pending/ with an
      // incremented attempt counter and let the next claim pick it up.
      await Promise.all(
        claimed.map(async (c) => {
          const nextAttempts = c.item.attempts + 1;
          if (nextAttempts >= maxAttempts) {
            const failedPath = join(failed, basename(c.inFlightPath));
            try {
              await rename(c.inFlightPath, failedPath);
              await writeFile(
                `${failedPath}.error`,
                `${new Date().toISOString()} ${error.message}\n`,
                "utf8",
              );
            } catch {
              // best-effort
            }
            return;
          }
          const updated: QueueItem = { ...c.item, attempts: nextAttempts };
          // Rewrite the file content with the bumped attempt count
          // and put it back in pending/. Use a fresh enqueue-style
          // tmp+rename so there's no partial-read window.
          const filename = basename(c.inFlightPath);
          const tmpPath = join(pending, `.tmp-${filename}`);
          const pendingPath = join(pending, filename);
          try {
            await writeFile(tmpPath, JSON.stringify(updated), "utf8");
            await rename(tmpPath, pendingPath);
            await rm(c.inFlightPath, { force: true });
          } catch {
            // best-effort; recovery sweep will pick it up next start.
          }
        }),
      );
    },
  };
}

/**
 * Recovery sweep. Called by the daemon on startup: any leftover items
 * in `in-flight/` belong to a worker that crashed, so move them back
 * to `pending/` for re-processing. Idempotent — safe to run any time
 * no worker is active.
 */
export async function recoverInFlight(opts: QueueOptions): Promise<number> {
  const { pending, inFlight } = await ensureDirs(opts.homeDir);
  const entries = (await readdir(inFlight)).filter(
    (f) => f.endsWith(".json") && !f.startsWith(".tmp-"),
  );
  let recovered = 0;
  for (const filename of entries) {
    try {
      await rename(join(inFlight, filename), join(pending, filename));
      recovered++;
    } catch {
      // best-effort
    }
  }
  return recovered;
}

/** Snapshot of queue depths. Used by `brain daemon status` and warnings. */
export async function stats(opts: QueueOptions): Promise<QueueStats> {
  const { pending, inFlight, failed } = await ensureDirs(opts.homeDir);
  const [p, i, f] = await Promise.all([countJson(pending), countJson(inFlight), countJson(failed)]);
  return { pending: p, inFlight: i, failed: f };
}

async function countJson(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-")).length;
  } catch {
    return 0;
  }
}

/** Filesystem `basename` without pulling in `path` again at every call site. */
function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** Test helper: confirm a queue directory exists and is empty across all states. */
export async function isEmpty(opts: QueueOptions): Promise<boolean> {
  const s = await stats(opts);
  return s.pending === 0 && s.inFlight === 0 && s.failed === 0;
}

void stat; // reserved for future per-item age inspection
