import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDedupPhase,
  createPatternsPhase,
  createStalePhase,
  createSynthesizePhase,
  linkFixPhase,
  type Phase,
  type PhaseContext,
  runCycle,
} from "../src/daemon/index.ts";
import { createMarkdownStore } from "../src/storage/markdown-store.ts";
import { createSqliteStorage } from "../src/storage/sqlite.ts";

const DIM = 4;

function unit(values: number[]): Float32Array {
  const v = new Float32Array(values);
  let n = 0;
  for (const x of v) n += x * x;
  const len = Math.sqrt(n);
  if (len === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / len;
  return v;
}

describe("daemon cycle", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "daemon-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function setup() {
    const storage = createSqliteStorage({ vectorDim: DIM });
    const markdownStore = createMarkdownStore({ rootDir });
    const ctx: Omit<PhaseContext, "runId"> = {
      storage,
      markdownStore,
      dryRun: false,
      now: () => Date.now(),
    };
    return { storage, markdownStore, ctx };
  }

  it("link-fix reconciles edges from disk", async () => {
    const { storage, markdownStore, ctx } = setup();
    const written = await markdownStore.write({
      scope: "test",
      type: "events",
      body: "User attended Sarah's wedding on March 15.",
      frontmatter: { id: "c1", type: "events", entities: ["Sarah"] },
    });
    storage.upsertChunk({
      id: "c1",
      path: written.filePath,
      type: "events",
      ordinal: 0,
      content: "User attended Sarah's wedding on March 15.",
      metadata: { entities: ["Sarah"] },
    });
    expect(storage.outboundEdges("c1")).toHaveLength(0);
    const report = await runCycle({ context: ctx, phases: [linkFixPhase] });
    expect(report.phases[0]?.status).toBe("ok");
    const edges = storage.outboundEdges("c1");
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.some((e) => e.linkType === "attended")).toBe(true);
    await storage.close();
  });

  it("dedup archives duplicates and emits superseded_by", async () => {
    const { storage, ctx } = setup();
    const emb = unit([1, 0, 0, 0]);
    storage.upsertChunks([
      {
        id: "a",
        path: "p/a.md",
        type: "facts",
        ordinal: 0,
        content: "User likes coffee in the morning.",
        embedding: emb,
      },
      {
        id: "b",
        path: "p/b.md",
        type: "facts",
        ordinal: 1,
        content: "User likes morning coffee.",
        embedding: emb, // identical embedding triggers dedup.
      },
    ]);
    expect(storage.size()).toBe(2);
    const report = await runCycle({
      context: ctx,
      phases: [createDedupPhase({ similarityThreshold: 0.9 })],
    });
    expect(report.phases[0]?.status).toBe("ok");
    expect(storage.size()).toBe(1);
    // Deterministic tiebreak: lex-smaller id wins ("a"); "b" archived.
    expect(storage.getChunk("a")).toBeDefined();
    expect(storage.getChunk("b")).toBeUndefined();
    const edges = storage.outboundEdges("b");
    expect(edges.some((e) => e.linkType === "superseded_by" && e.toChunkId === "a")).toBe(true);
    await storage.close();
  });

  it("dedup skips aggregates / observations / episodic", async () => {
    const { storage, ctx } = setup();
    const emb = unit([1, 0, 0, 0]);
    storage.upsertChunks([
      {
        id: "a",
        path: "p/a.md",
        type: "aggregates",
        ordinal: 0,
        content: "summary 1",
        embedding: emb,
      },
      {
        id: "b",
        path: "p/b.md",
        type: "aggregates",
        ordinal: 1,
        content: "summary 2",
        embedding: emb,
      },
    ]);
    await runCycle({ context: ctx, phases: [createDedupPhase({ similarityThreshold: 0.9 })] });
    expect(storage.size()).toBe(2);
    await storage.close();
  });

  it("stale archives orphan chunks past the threshold", async () => {
    const { storage, ctx } = setup();
    storage.upsertChunk({
      id: "old",
      path: "p/old.md",
      type: "facts",
      ordinal: 0,
      content: "ancient orphan",
      metadata: { createdAt: 0 }, // epoch — definitely stale
    });
    storage.upsertChunk({
      id: "fresh",
      path: "p/fresh.md",
      type: "facts",
      ordinal: 1,
      content: "recent orphan",
      metadata: { createdAt: Date.now() }, // not stale
    });
    expect(storage.size()).toBe(2);
    await runCycle({ context: ctx, phases: [createStalePhase({ staleAfterMs: 1000 })] });
    expect(storage.getChunk("old")).toBeUndefined();
    expect(storage.getChunk("fresh")).toBeDefined();
    await storage.close();
  });

  it("synthesize / patterns skip with not_configured when generator is absent", async () => {
    const { storage, ctx } = setup();
    const synth = createSynthesizePhase({
      loadRecentTranscripts: async () => [],
    });
    const pat = createPatternsPhase({
      loadRecentReflections: async () => [],
    });
    const report = await runCycle({ context: ctx, phases: [synth, pat] });
    expect(report.phases[0]?.message).toBe("not_configured");
    expect(report.phases[1]?.message).toBe("not_configured");
    await storage.close();
  });

  it("respects cooldown between cycles", async () => {
    const { storage, ctx } = setup();
    let now = 1_000_000;
    const cooldownPhase: Phase = {
      name: "cooldown-test",
      cooldownMs: 60_000,
      run: async () => ({ phase: "cooldown-test", status: "ok", durationMs: 0 }),
    };
    const localCtx = { ...ctx, now: () => now };
    const r1 = await runCycle({ context: localCtx, phases: [cooldownPhase] });
    expect(r1.phases[0]?.status).toBe("ok");
    now += 1000; // 1s later — should still be cooled down.
    const r2 = await runCycle({ context: localCtx, phases: [cooldownPhase] });
    expect(r2.phases[0]?.message).toContain("cooldown_active");
    now += 60_000; // past cooldown.
    const r3 = await runCycle({ context: localCtx, phases: [cooldownPhase] });
    expect(r3.phases[0]?.status).toBe("ok");
    await storage.close();
  });

  it("dryRun avoids any writes", async () => {
    const { storage, ctx } = setup();
    const emb = unit([1, 0, 0, 0]);
    storage.upsertChunks([
      { id: "a", path: "p/a.md", type: "facts", ordinal: 0, content: "foo", embedding: emb },
      { id: "b", path: "p/b.md", type: "facts", ordinal: 1, content: "bar", embedding: emb },
    ]);
    await runCycle({
      context: { ...ctx, dryRun: true },
      phases: [createDedupPhase({ similarityThreshold: 0.9 })],
    });
    expect(storage.size()).toBe(2);
    await storage.close();
  });
});
