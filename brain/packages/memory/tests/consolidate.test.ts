import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConsolidationCache } from "../src/consolidate/cache.ts";
import { createLlmConsolidator } from "../src/consolidate/llm.ts";
import type { WrittenChunk } from "../src/write/types.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "consol-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("createConsolidationCache", () => {
  const facts = [
    { content: "fact A", entity: "wedding" },
    { content: "fact B", entity: "wedding" },
  ];

  it("misses on first call, hits after set", () => {
    withTempDir((dir) => {
      const cache = createConsolidationCache({ cacheDir: dir, cacheKey: "test:v1" });
      expect(cache.get(facts)).toBeUndefined();
      cache.set(facts, { entity: "wedding", content: "summary" });
      const got = cache.get(facts);
      expect(got?.content).toBe("summary");
      expect(cache.hits).toBe(1);
      expect(cache.misses).toBe(1);
    });
  });

  it("is order-insensitive — same facts in different order produce same key", () => {
    withTempDir((dir) => {
      const cache = createConsolidationCache({ cacheDir: dir, cacheKey: "test:v1" });
      cache.set(facts, { entity: "wedding", content: "summary" });
      const reversed = [...facts].reverse();
      expect(cache.get(reversed)?.content).toBe("summary");
    });
  });

  it("namespaces by cacheKey", () => {
    withTempDir((dir) => {
      const a = createConsolidationCache({ cacheDir: dir, cacheKey: "model-a:v1" });
      const b = createConsolidationCache({ cacheDir: dir, cacheKey: "model-b:v1" });
      a.set(facts, { entity: "wedding", content: "from-a" });
      expect(b.get(facts)).toBeUndefined();
    });
  });
});

describe("createLlmConsolidator", () => {
  // We can't hit an LLM in tests, so use the cache to short-circuit:
  // pre-seed the cache with the expected aggregate, and the consolidator
  // returns it without calling the model. The model field still has to
  // be a valid object (zod-validated by ai's generateObject), but it
  // never gets invoked when the cache hits.
  const stubModel = "stub" as never;

  function chunk(content: string, entities: string[], ordinal: number): WrittenChunk {
    return {
      type: "facts",
      ordinal,
      content,
      metadata: entities.length > 0 ? { factType: "fact", entities } : { factType: "fact" },
    };
  }

  it("groups by primary entity and emits aggregate at aggregate-* path", async () => {
    await withTempDir(async (dir) => {
      const cache = createConsolidationCache({ cacheDir: dir, cacheKey: "stub:v1" });
      // Cache key derives from compound `${kind}:${entity}` so the
      // entity-group lookup matches "entity:wedding".
      const inputs = [
        { content: "Sarah's wedding on March 15", entity: "entity:wedding" },
        { content: "Lisa's wedding on June 8", entity: "entity:wedding" },
      ];
      cache.set(inputs, { entity: "wedding", content: "User attended 2 weddings: Sarah, Lisa." });

      const consolidator = createLlmConsolidator({ model: stubModel, cache });
      const out = await consolidator.consolidate(
        [
          chunk("Sarah's wedding on March 15", ["wedding"], 1),
          chunk("Lisa's wedding on June 8", ["wedding"], 2),
        ],
        100,
      );

      expect(out).toHaveLength(1);
      expect(out[0]?.type).toBe("aggregates");
      expect(out[0]?.content).toContain("2 weddings");
      expect((out[0]?.metadata?.entities as string[])?.[0]).toBe("wedding");
      expect(out[0]?.ordinal).toBe(100);
    });
  });

  it("skips chunks without entity metadata", async () => {
    const consolidator = createLlmConsolidator({ model: stubModel });
    const out = await consolidator.consolidate(
      [chunk("user: hello", [], 1), chunk("assistant: hi", [], 2)],
      100,
    );
    expect(out).toEqual([]);
  });

  it("skips entity groups smaller than minGroupSize (default 2)", async () => {
    const consolidator = createLlmConsolidator({ model: stubModel });
    const out = await consolidator.consolidate(
      [chunk("Sarah's wedding on March 15", ["wedding"], 1)],
      100,
    );
    expect(out).toEqual([]);
  });

  it("returns empty when there are no chunks", async () => {
    const consolidator = createLlmConsolidator({ model: stubModel });
    const out = await consolidator.consolidate([], 0);
    expect(out).toEqual([]);
  });

  it("emits one aggregate per entity group", async () => {
    await withTempDir(async (dir) => {
      const cache = createConsolidationCache({ cacheDir: dir, cacheKey: "stub:v1" });
      cache.set(
        [
          { content: "wedding A", entity: "entity:wedding" },
          { content: "wedding B", entity: "entity:wedding" },
        ],
        { entity: "wedding", content: "2 weddings" },
      );
      cache.set(
        [
          { content: "trip A", entity: "entity:trip" },
          { content: "trip B", entity: "entity:trip" },
        ],
        { entity: "trip", content: "2 trips" },
      );

      const consolidator = createLlmConsolidator({ model: "stub" as never, cache });
      const out = await consolidator.consolidate(
        [
          chunk("wedding A", ["wedding"], 1),
          chunk("wedding B", ["wedding"], 2),
          chunk("trip A", ["trip"], 3),
          chunk("trip B", ["trip"], 4),
        ],
        100,
      );
      expect(out).toHaveLength(2);
      expect(out.flatMap((c) => c.metadata?.entities ?? [])).toEqual(
        expect.arrayContaining(["wedding", "trip"]),
      );
    });
  });

  it("groups by topic in addition to entity, emitting topic-kind aggregate", async () => {
    function chunkWithTopics(
      content: string,
      entities: string[],
      topics: string[],
      ordinal: number,
    ): WrittenChunk {
      return {
        type: "facts",
        ordinal,
        content,
        metadata: { factType: "fact", entities, topics },
      };
    }

    await withTempDir(async (dir) => {
      const cache = createConsolidationCache({ cacheDir: dir, cacheKey: "stub:v1" });
      // Three different specific items, all under the topic "furniture".
      cache.set(
        [
          { content: "bought a bookshelf at IKEA", entity: "topic:furniture" },
          { content: "assembled a chair from CB2", entity: "topic:furniture" },
          { content: "fixed a wobbly desk leg", entity: "topic:furniture" },
        ],
        {
          entity: "furniture",
          content: "User had 3 furniture interactions: bookshelf, chair, desk.",
        },
      );

      const consolidator = createLlmConsolidator({
        model: "stub" as never,
        cache,
        groupByTopic: true,
      });
      const out = await consolidator.consolidate(
        [
          chunkWithTopics("bought a bookshelf at IKEA", ["bookshelf"], ["furniture"], 1),
          chunkWithTopics("assembled a chair from CB2", ["chair"], ["furniture"], 2),
          chunkWithTopics("fixed a wobbly desk leg", ["desk"], ["furniture"], 3),
        ],
        100,
      );
      // Each item-entity has only 1 fact (skipped). Topic "furniture"
      // groups all 3 → 1 topic-aggregate.
      expect(out).toHaveLength(1);
      expect(out[0]?.type).toBe("aggregates");
      expect(out[0]?.metadata?.kind as string).toBe("topic");
      expect((out[0]?.metadata?.topics as string[])?.[0]).toBe("furniture");
    });
  });
});
