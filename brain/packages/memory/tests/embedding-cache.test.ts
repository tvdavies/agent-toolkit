import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEmbeddingCache,
  type EmbeddingCache,
  withEmbeddingCache,
} from "../src/embedding/cache.ts";
import type { Embedder } from "../src/embedding/types.ts";

function vec(...nums: number[]): Float32Array {
  return new Float32Array(nums);
}

function deterministicEmbedder(): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    id: "test-embedder",
    dim: 3,
    async embed(texts) {
      calls.push([...texts]);
      // Simple deterministic mapping: each text -> [text.length, hash mod, last char code].
      return texts.map((t) => vec(t.length, t.charCodeAt(0), t.charCodeAt(t.length - 1) ?? 0));
    },
    calls,
  } as Embedder & { calls: string[][] };
}

describe("createEmbeddingCache", () => {
  let dir: string;
  let cache: EmbeddingCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "embed-cache-"));
    cache = createEmbeddingCache({ dbPath: join(dir, "cache.sqlite") });
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the cache directory and sqlite file with private permissions", () => {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "cache.sqlite")).mode & 0o777).toBe(0o600);
  });

  it("get returns undefined for missing entries", () => {
    expect(cache.get("model-a", "hello")).toBeUndefined();
  });

  it("set then get round-trips the float vector", () => {
    cache.set("model-a", "hello", vec(1, 2, 3, 4, 5));
    const got = cache.get("model-a", "hello");
    expect(got).toBeInstanceOf(Float32Array);
    if (got === undefined) throw new Error("missing cached vector");
    expect(Array.from(got)).toEqual([1, 2, 3, 4, 5]);
  });

  it("(model_id, text) is the cache key — same text under different models is distinct", () => {
    cache.set("model-a", "hello", vec(1, 0, 0));
    cache.set("model-b", "hello", vec(0, 1, 0));
    const modelA = cache.get("model-a", "hello");
    const modelB = cache.get("model-b", "hello");
    if (modelA === undefined || modelB === undefined) throw new Error("missing cached vector");
    expect(Array.from(modelA)).toEqual([1, 0, 0]);
    expect(Array.from(modelB)).toEqual([0, 1, 0]);
  });

  it("set overwrites on duplicate key", () => {
    cache.set("model-a", "hello", vec(1, 2, 3));
    cache.set("model-a", "hello", vec(7, 8, 9));
    const got = cache.get("model-a", "hello");
    if (got === undefined) throw new Error("missing cached vector");
    expect(Array.from(got)).toEqual([7, 8, 9]);
  });

  it("size reports the row count", () => {
    expect(cache.size()).toBe(0);
    cache.set("m", "a", vec(1));
    cache.set("m", "b", vec(2));
    cache.set("m", "c", vec(3));
    expect(cache.size()).toBe(3);
  });

  it("LRU eviction drops the least-recently-accessed past maxEntries", () => {
    cache.close();
    cache = createEmbeddingCache({ dbPath: join(dir, "lru.sqlite"), maxEntries: 3 });
    cache.set("m", "a", vec(1));
    cache.set("m", "b", vec(2));
    cache.set("m", "c", vec(3));
    expect(cache.size()).toBe(3);
    // Touch a so it's most-recent.
    cache.get("m", "a");
    // Adding a fourth entry should evict the oldest by last_accessed_at,
    // which is now "b" (a was just touched, c was inserted after b).
    cache.set("m", "d", vec(4));
    expect(cache.size()).toBe(3);
    expect(cache.get("m", "a")).toBeDefined();
    expect(cache.get("m", "b")).toBeUndefined(); // evicted
    expect(cache.get("m", "c")).toBeDefined();
    expect(cache.get("m", "d")).toBeDefined();
  });

  it("persists across cache instances on the same dbPath", () => {
    cache.set("m", "remembered", vec(42, 43, 44));
    cache.close();
    const second = createEmbeddingCache({ dbPath: join(dir, "cache.sqlite") });
    try {
      const got = second.get("m", "remembered");
      expect(got).toBeDefined();
      if (got === undefined) throw new Error("missing cached vector");
      expect(Array.from(got)).toEqual([42, 43, 44]);
    } finally {
      second.close();
      // Re-open primary so afterEach can close it cleanly.
      cache = createEmbeddingCache({ dbPath: join(dir, "cache.sqlite") });
    }
  });
});

describe("withEmbeddingCache", () => {
  let dir: string;
  let cache: EmbeddingCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wrap-cache-"));
    cache = createEmbeddingCache({ dbPath: join(dir, "cache.sqlite") });
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("first call hits the inner embedder, second call hits the cache", async () => {
    const inner = deterministicEmbedder();
    const wrapped = withEmbeddingCache(inner, cache);
    await wrapped.embed(["hello", "world"]);
    expect(inner.calls).toEqual([["hello", "world"]]);
    await wrapped.embed(["hello", "world"]);
    // No additional inner call — both were cached.
    expect(inner.calls).toEqual([["hello", "world"]]);
  });

  it("partial cache hit only sends missing texts to the inner", async () => {
    const inner = deterministicEmbedder();
    const wrapped = withEmbeddingCache(inner, cache);
    await wrapped.embed(["a", "b"]);
    inner.calls.length = 0;
    await wrapped.embed(["a", "c", "b", "d"]);
    // a + b were cached; c + d are misses.
    expect(inner.calls).toEqual([["c", "d"]]);
  });

  it("preserves output order across cache hits and misses", async () => {
    const inner = deterministicEmbedder();
    const wrapped = withEmbeddingCache(inner, cache);
    await wrapped.embed(["seed"]);
    inner.calls.length = 0;
    const out = await wrapped.embed(["fresh-1", "seed", "fresh-2"]);
    expect(out).toHaveLength(3);
    // fresh-1 has length 7; seed has length 4; fresh-2 has length 7.
    expect(out[0]?.[0]).toBe(7);
    expect(out[1]?.[0]).toBe(4); // cached
    expect(out[2]?.[0]).toBe(7);
  });

  it("empty input returns empty output without touching inner", async () => {
    const inner = deterministicEmbedder();
    const wrapped = withEmbeddingCache(inner, cache);
    const out = await wrapped.embed([]);
    expect(out).toEqual([]);
    expect(inner.calls).toHaveLength(0);
  });

  it("ignores cached vectors whose dimension does not match the inner embedder", async () => {
    cache.set("test-embedder", "hello", vec(1, 2));
    const inner = deterministicEmbedder();
    const wrapped = withEmbeddingCache(inner, cache);

    const out = await wrapped.embed(["hello"]);

    expect(inner.calls).toEqual([["hello"]]);
    expect(out[0]?.length).toBe(3);
  });

  it("forwards id and dim from inner unchanged", () => {
    const inner = deterministicEmbedder();
    const wrapped = withEmbeddingCache(inner, cache);
    expect(wrapped.id).toBe(inner.id);
    expect(wrapped.dim).toBe(inner.dim);
  });
});
