/**
 * Integration test for OurMemory's async write mode.
 *
 * Confirms that with `homeDir` set:
 *   - `record()` runs the syncWriter (verbatim chunk lands immediately
 *     in the BM25 index), and
 *   - the event is enqueued under <homeDir>/queue/pending/ for a
 *     daemon worker to run the slow writer chain later.
 *
 * Sync mode (no `homeDir`) is left unchanged and verified separately
 * by the existing memory tests; this file targets the new async path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOurMemory } from "../src/memory.js";
import { stats } from "../src/queue/queue.js";
import { verbatimWriter, type Writer, type WrittenChunk } from "../src/write/index.js";

let homeDir = "";
let rootDir = "";

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "memory-async-home-"));
  rootDir = await mkdtemp(join(tmpdir(), "memory-async-root-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
  await rm(rootDir, { recursive: true, force: true });
});

/** Writer that records every call so tests can assert which chain ran. */
function spyWriter(label: string): Writer & { calls: number } {
  const w: Writer & { calls: number } = {
    calls: 0,
    async process(events): Promise<WrittenChunk[]> {
      w.calls++;
      // Emit one observation per event so the spy is distinguishable
      // from a no-op while still landing in storage.
      return events.map((e, i) => ({
        type: "observations",
        ordinal: i,
        content: `${label}: ${formatForSpy(e)}`,
      }));
    },
  };
  return w;
}

function formatForSpy(e: { kind: string; text?: string; content?: string }): string {
  if (e.kind === "user-turn" || e.kind === "assistant-turn") return e.text ?? "";
  return e.content ?? "";
}

describe("OurMemory async write mode", () => {
  test("record() runs syncWriter and enqueues the event", async () => {
    const sync = spyWriter("sync");
    const slow = spyWriter("slow");
    const memory = await createOurMemory({
      rootDir,
      scope: "personal",
      homeDir,
      syncWriter: sync,
      writer: slow,
    });

    await memory.record({ kind: "user-turn", text: "hello there" });

    // Sync writer fired exactly once. Slow writer didn't — that's
    // the daemon's job and there's no daemon in this test.
    expect(sync.calls).toBe(1);
    expect(slow.calls).toBe(0);

    // Queue has the enqueued event waiting for a worker.
    const s = await stats({ homeDir });
    expect(s.pending).toBe(1);
    expect(s.inFlight).toBe(0);

    await memory.close?.();
  });

  test("processQueuedEvent runs the slow writer chain", async () => {
    const sync = spyWriter("sync");
    const slow = spyWriter("slow");
    const memory = await createOurMemory({
      rootDir,
      scope: "personal",
      homeDir,
      syncWriter: sync,
      writer: slow,
    });

    await memory.record({ kind: "user-turn", text: "queued" });
    expect(slow.calls).toBe(0);

    // Daemon-side: simulate worker claim by directly calling the
    // public processQueuedEvent. In production the daemon's queue-
    // drain phase does this with claimed items.
    await (
      memory as unknown as { processQueuedEvent: (e: unknown) => Promise<void> }
    ).processQueuedEvent({ kind: "user-turn", text: "queued" });
    expect(slow.calls).toBe(1);

    await memory.close?.();
  });

  test("retrieve() does not auto-flush in async mode", async () => {
    // verbatimWriter runs as syncWriter; legacy buffered-flush would
    // re-run the slow writer here. In async mode it must not.
    const slow = spyWriter("slow");
    const memory = await createOurMemory({
      rootDir,
      scope: "personal",
      homeDir,
      syncWriter: verbatimWriter,
      writer: slow,
    });

    await memory.record({ kind: "user-turn", text: "no-flush-on-retrieve" });
    await memory.retrieve({ query: "anything" });
    expect(slow.calls).toBe(0);

    await memory.close?.();
  });

  test("sync mode (no homeDir) keeps legacy behaviour", async () => {
    // No homeDir set: record() buffers, retrieve()/flush() runs the
    // slow writer chain. No queue should appear on disk.
    const slow = spyWriter("slow");
    const memory = await createOurMemory({
      rootDir,
      scope: "personal",
      writer: slow,
    });

    await memory.record({ kind: "user-turn", text: "buffered" });
    expect(slow.calls).toBe(0);

    await memory.flush?.();
    expect(slow.calls).toBe(1);

    await memory.close?.();
  });

  test("flush() in async mode resolves once queue drains", async () => {
    const memory = await createOurMemory({
      rootDir,
      scope: "personal",
      homeDir,
      syncWriter: verbatimWriter,
      writer: verbatimWriter,
    });

    await memory.record({ kind: "user-turn", text: "drain-me" });
    let s = await stats({ homeDir });
    expect(s.pending).toBe(1);

    // Simulate a daemon claim+ack out of band. flush() should then
    // observe the empty queue and resolve.
    const { claim } = await import("../src/queue/queue.js");
    const c = await claim({ homeDir, maxItems: 10 });
    expect(c?.items.length).toBe(1);
    await c?.ack();
    s = await stats({ homeDir });
    expect(s).toEqual({ pending: 0, inFlight: 0, failed: 0 });

    await memory.flush?.({ timeoutMs: 1000 });

    await memory.close?.();
  });

  test("flush() in async mode times out when queue stays full", async () => {
    const memory = await createOurMemory({
      rootDir,
      scope: "personal",
      homeDir,
      syncWriter: verbatimWriter,
      writer: verbatimWriter,
    });
    await memory.record({ kind: "user-turn", text: "stuck" });
    await expect(memory.flush?.({ timeoutMs: 200 })).rejects.toThrow(/did not drain/);
    await memory.close?.();
  });
});
