import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, enqueue, isEmpty, recoverInFlight, stats } from "../src/queue/queue.js";

let homeDir = "";

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "queue-test-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe("queue", () => {
  test("enqueue then claim returns the items in FIFO order", async () => {
    // Filenames sort by ISO timestamp + nanoid suffix; the nanoid
    // suffix is what disambiguates same-millisecond enqueues, so
    // rapid bursts within one ms aren't strictly FIFO. Sleeping
    // pushes the test pair into distinct millisecond buckets to
    // pin down the ordering claim we actually care about.
    await enqueue({
      homeDir,
      scope: "personal",
      event: { kind: "user-turn", text: "first" },
    });
    await new Promise((r) => setTimeout(r, 5));
    await enqueue({
      homeDir,
      scope: "personal",
      event: { kind: "user-turn", text: "second" },
    });

    const c = await claim({ homeDir, maxItems: 10 });
    expect(c).not.toBeNull();
    expect(c?.items.length).toBe(2);
    const texts = c?.items.map((it) => (it.event.kind === "user-turn" ? it.event.text : ""));
    expect(texts).toEqual(["first", "second"]);
  });

  test("claim returns null when nothing pending", async () => {
    const c = await claim({ homeDir, maxItems: 5 });
    expect(c).toBeNull();
  });

  test("ack removes items from in-flight", async () => {
    await enqueue({ homeDir, scope: "personal", event: { kind: "user-turn", text: "x" } });
    const c = await claim({ homeDir, maxItems: 10 });
    expect(c).not.toBeNull();
    await c?.ack();
    const s = await stats({ homeDir });
    expect(s).toEqual({ pending: 0, inFlight: 0, failed: 0 });
  });

  test("fail under maxAttempts requeues with bumped counter", async () => {
    await enqueue({ homeDir, scope: "personal", event: { kind: "user-turn", text: "retry-me" } });
    const c1 = await claim({ homeDir, maxItems: 10, maxAttempts: 3 });
    expect(c1?.items[0]?.attempts).toBe(0);
    await c1?.fail(new Error("boom"));

    const sAfterFail = await stats({ homeDir });
    expect(sAfterFail.pending).toBe(1);
    expect(sAfterFail.inFlight).toBe(0);
    expect(sAfterFail.failed).toBe(0);

    const c2 = await claim({ homeDir, maxItems: 10, maxAttempts: 3 });
    expect(c2?.items[0]?.attempts).toBe(1);
  });

  test("fail at maxAttempts moves to failed/", async () => {
    await enqueue({ homeDir, scope: "personal", event: { kind: "user-turn", text: "doomed" } });
    // maxAttempts = 1 so the first failure is terminal.
    const c = await claim({ homeDir, maxItems: 10, maxAttempts: 1 });
    await c?.fail(new Error("permanent"));
    const s = await stats({ homeDir });
    expect(s).toEqual({ pending: 0, inFlight: 0, failed: 1 });

    // Error message lands in a sidecar file alongside the failed item.
    const failedDir = join(homeDir, "queue", "failed");
    const files = await readdir(failedDir);
    const errorFiles = files.filter((f) => f.endsWith(".error"));
    expect(errorFiles.length).toBe(1);
  });

  test("recoverInFlight requeues abandoned items", async () => {
    await enqueue({ homeDir, scope: "personal", event: { kind: "user-turn", text: "crashy" } });
    const c = await claim({ homeDir, maxItems: 10 });
    expect(c?.items.length).toBe(1);
    // Simulate the worker process dying without ack/fail by just walking
    // away from `c`. The in-flight file is still there.
    let s = await stats({ homeDir });
    expect(s.inFlight).toBe(1);
    expect(s.pending).toBe(0);

    const recovered = await recoverInFlight({ homeDir });
    expect(recovered).toBe(1);
    s = await stats({ homeDir });
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(1);
  });

  test("scope filter only claims matching items", async () => {
    await enqueue({ homeDir, scope: "personal", event: { kind: "user-turn", text: "p" } });
    await enqueue({ homeDir, scope: "work", event: { kind: "user-turn", text: "w" } });
    const c = await claim({ homeDir, maxItems: 10, scope: "personal" });
    expect(c?.items.length).toBe(1);
    expect(c?.items[0]?.scope).toBe("personal");
    // Work item still pending after the personal claim.
    const s = await stats({ homeDir });
    expect(s.pending).toBe(1);
    expect(s.inFlight).toBe(1);
  });

  test("isEmpty reflects all three state directories", async () => {
    expect(await isEmpty({ homeDir })).toBe(true);
    await enqueue({ homeDir, scope: "personal", event: { kind: "user-turn", text: "x" } });
    expect(await isEmpty({ homeDir })).toBe(false);
    const c = await claim({ homeDir, maxItems: 10 });
    await c?.ack();
    expect(await isEmpty({ homeDir })).toBe(true);
  });

  test("maxItems caps the batch size", async () => {
    for (let i = 0; i < 5; i++) {
      await enqueue({
        homeDir,
        scope: "personal",
        event: { kind: "user-turn", text: `item-${i}` },
      });
    }
    const c = await claim({ homeDir, maxItems: 3 });
    expect(c?.items.length).toBe(3);
    const s = await stats({ homeDir });
    expect(s.pending).toBe(2);
    expect(s.inFlight).toBe(3);
  });

  test("malformed json files end up in failed/", async () => {
    const queueDir = join(homeDir, "queue", "pending");
    await Bun.$`mkdir -p ${queueDir}`.quiet();
    const badPath = join(queueDir, "2026-01-01T00-00-00-000Z-bad.json");
    await Bun.write(badPath, "not json at all");

    const c = await claim({ homeDir, maxItems: 10 });
    // No valid items so claim returns null.
    expect(c).toBeNull();
    const s = await stats({ homeDir });
    expect(s.failed).toBe(1);
  });
});
