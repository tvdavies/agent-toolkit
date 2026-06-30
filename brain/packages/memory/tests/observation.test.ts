import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createObservationCache,
  createObservationWriter,
  type Observation,
} from "../src/write/observation.ts";
import type { WriteEvent } from "../src/write/types.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "obs-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("createObservationCache", () => {
  const session: WriteEvent[] = [
    { kind: "user-turn", text: "I attended Sarah's wedding last week", recordedAt: "2024-03-20" },
    { kind: "assistant-turn", text: "How nice! Was it a good ceremony?" },
  ];
  const observations: Observation[] = [
    { priority: "high", content: "User attended Sarah's wedding on March 15, 2024." },
  ];

  it("misses on first lookup, hits after set", () => {
    withTempDir((dir) => {
      const cache = createObservationCache({ cacheDir: dir, cacheKey: "test:v1" });
      expect(cache.get(session)).toBeUndefined();
      cache.set(session, observations);
      const got = cache.get(session);
      expect(got).toEqual(observations);
      expect(cache.hits).toBe(1);
      expect(cache.misses).toBe(1);
    });
  });

  it("namespaces by cacheKey", () => {
    withTempDir((dir) => {
      const a = createObservationCache({ cacheDir: dir, cacheKey: "model-a:v1" });
      const b = createObservationCache({ cacheDir: dir, cacheKey: "model-b:v1" });
      a.set(session, observations);
      expect(b.get(session)).toBeUndefined();
      expect(a.get(session)).toEqual(observations);
    });
  });

  it("strips recordedAt from cache key (LLM doesn't see it)", () => {
    withTempDir((dir) => {
      const cache = createObservationCache({ cacheDir: dir, cacheKey: "test:v1" });
      cache.set(session, observations);
      const sessionDifferentDate = session.map((e) => ({ ...e, recordedAt: "2024-04-01" }));
      // Should hit — visible payload (kind + text) is identical.
      expect(cache.get(sessionDifferentDate)).toEqual(observations);
    });
  });
});

describe("createObservationWriter", () => {
  const stubModel = "stub" as never;

  it("returns no chunks for empty input", async () => {
    const writer = createObservationWriter({ model: stubModel });
    expect(await writer.process([], 0)).toEqual([]);
  });

  it("groups events by recordedAt session boundary", async () => {
    await withTempDir(async (dir) => {
      const cache = createObservationCache({ cacheDir: dir, cacheKey: "stub:v1" });
      const session1: WriteEvent[] = [
        { kind: "user-turn", text: "alpha", recordedAt: "2024-03-15" },
        { kind: "assistant-turn", text: "beta", recordedAt: "2024-03-15" },
      ];
      const session2: WriteEvent[] = [
        { kind: "user-turn", text: "gamma", recordedAt: "2024-04-20" },
        { kind: "assistant-turn", text: "delta", recordedAt: "2024-04-20" },
      ];
      cache.set(session1, [{ priority: "high", content: "obs from session 1" }]);
      cache.set(session2, [{ priority: "medium", content: "obs from session 2" }]);

      const writer = createObservationWriter({ model: stubModel, cache });
      const out = await writer.process([...session1, ...session2], 100);
      expect(out).toHaveLength(2);
      expect(out[0]?.type).toBe("observations");
      expect(out[1]?.type).toBe("observations");
      expect(out[0]?.content).toContain("obs from session 1");
      expect(out[1]?.content).toContain("obs from session 2");
    });
  });

  it("emits chunks with priority emojis prepended", async () => {
    await withTempDir(async (dir) => {
      const cache = createObservationCache({ cacheDir: dir, cacheKey: "stub:v1" });
      const session: WriteEvent[] = [{ kind: "user-turn", text: "x", recordedAt: "2024-03-15" }];
      cache.set(session, [
        { priority: "high", content: "user fact" },
        { priority: "medium", content: "activity" },
        { priority: "low", content: "uncertain" },
        { priority: "resolved", content: "completed task" },
      ]);
      const writer = createObservationWriter({ model: stubModel, cache });
      const out = await writer.process(session, 0);
      expect(out[0]?.content).toBe("🔴 user fact");
      expect(out[1]?.content).toBe("🟡 activity");
      expect(out[2]?.content).toBe("🟢 uncertain");
      expect(out[3]?.content).toBe("✅ completed task");
    });
  });

  it("respects maxPerSession cap", async () => {
    await withTempDir(async (dir) => {
      const cache = createObservationCache({ cacheDir: dir, cacheKey: "stub:v1" });
      const session: WriteEvent[] = [{ kind: "user-turn", text: "x", recordedAt: "2024-03-15" }];
      const many: Observation[] = Array.from({ length: 12 }, (_, i) => ({
        priority: "medium" as const,
        content: `obs ${i}`,
      }));
      cache.set(session, many);
      const writer = createObservationWriter({ model: stubModel, cache, maxPerSession: 5 });
      const out = await writer.process(session, 0);
      expect(out).toHaveLength(5);
    });
  });

  it("metadata includes priority and recordedAt", async () => {
    await withTempDir(async (dir) => {
      const cache = createObservationCache({ cacheDir: dir, cacheKey: "stub:v1" });
      const session: WriteEvent[] = [{ kind: "user-turn", text: "x", recordedAt: "2024-03-15" }];
      cache.set(session, [{ priority: "high", content: "fact", entities: ["Sarah"] }]);
      const writer = createObservationWriter({ model: stubModel, cache });
      const out = await writer.process(session, 0);
      expect(out[0]?.type).toBe("observations");
      expect(out[0]?.metadata?.priority).toBe("high");
      expect(out[0]?.metadata?.recordedAt).toBe("2024-03-15");
      expect(out[0]?.metadata?.entities).toEqual(["Sarah"]);
    });
  });
});
