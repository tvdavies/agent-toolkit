import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOurMemory } from "../src/memory.ts";
import {
  createFactCache,
  createHybridWriter,
  type Fact,
  formatTurnEvent,
  verbatimWriter,
  type WriteEvent,
  type Writer,
} from "../src/write/index.ts";

describe("verbatimWriter", () => {
  it("produces one chunk per event", async () => {
    const events: WriteEvent[] = [
      { kind: "user-turn", text: "hi" },
      { kind: "assistant-turn", text: "hello" },
      { kind: "ingested-item", content: "logged event" },
    ];
    const chunks = await verbatimWriter.process(events, 0);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.content).toBe("user: hi");
    expect(chunks[1]?.content).toBe("assistant: hello");
    expect(chunks[2]?.content).toBe("logged event");
  });

  it("assigns ordinals starting at baseOrdinal", async () => {
    const events: WriteEvent[] = [
      { kind: "user-turn", text: "a" },
      { kind: "user-turn", text: "b" },
    ];
    const chunks = await verbatimWriter.process(events, 100);
    expect(chunks[0]?.ordinal).toBe(100);
    expect(chunks[1]?.ordinal).toBe(101);
  });
});

describe("formatTurnEvent", () => {
  it("prefixes user/assistant; passes ingested through", () => {
    expect(formatTurnEvent({ kind: "user-turn", text: "x" })).toBe("user: x");
    expect(formatTurnEvent({ kind: "assistant-turn", text: "y" })).toBe("assistant: y");
    expect(formatTurnEvent({ kind: "ingested-item", content: "z" })).toBe("z");
  });
});

describe("memory: pluggable writer", () => {
  let memRoot: string;
  beforeEach(() => {
    memRoot = mkdtempSync(join(tmpdir(), "memory-write-"));
  });
  afterEach(() => {
    rmSync(memRoot, { recursive: true, force: true });
  });
  const memOpts = () => ({ rootDir: memRoot, scope: "test" });

  it("uses a custom writer that produces fewer chunks than events", async () => {
    // Stub writer: every 3 events → 1 chunk summarising them.
    let calls = 0;
    const stub: Writer = {
      async process(events, base) {
        calls++;
        const groups: string[] = [];
        for (let i = 0; i < events.length; i += 3) {
          const slice = events.slice(i, i + 3);
          groups.push(slice.map(formatTurnEvent).join(" | "));
        }
        return groups.map((content, i) => ({
          type: "context" as const,
          ordinal: base + i,
          content,
        }));
      },
    };

    const memory = await createOurMemory({ ...memOpts(), writer: stub });
    try {
      for (let i = 0; i < 6; i++) {
        await memory.record({ kind: "user-turn", text: `turn ${i}` });
      }
      const r = await memory.retrieve({ query: "turn 4" });
      expect(calls).toBe(1);
      expect(r.items.length).toBeGreaterThan(0);
      // Should have hit a 3-event group containing "turn 3 | turn 4 | turn 5"
      expect(r.items[0]?.content).toContain("turn 4");
    } finally {
      await memory.close?.();
    }
  });

  it("default writer archives conversation turns outside normal recall", async () => {
    const memory = await createOurMemory(memOpts());
    try {
      await memory.record({ kind: "user-turn", text: "alpha" });
      await memory.record({ kind: "user-turn", text: "beta" });
      const r = await memory.retrieve({ query: "alpha" });
      expect(r.items).toEqual([]);
    } finally {
      await memory.close?.();
    }
  });
});

describe("createHybridWriter", () => {
  let memRoot: string;
  beforeEach(() => {
    memRoot = mkdtempSync(join(tmpdir(), "memory-hybrid-"));
  });
  afterEach(() => {
    rmSync(memRoot, { recursive: true, force: true });
  });
  const memOpts = () => ({ rootDir: memRoot, scope: "test" });

  const summarizingStub: Writer = {
    async process(events, base) {
      return [
        {
          type: "aggregates" as const,
          ordinal: base,
          content: events.map(formatTurnEvent).join(" | "),
        },
      ];
    },
  };

  it("concatenates output of every sub-writer", async () => {
    const hybrid = createHybridWriter([verbatimWriter, summarizingStub]);
    const events: WriteEvent[] = [
      { kind: "user-turn", text: "a" },
      { kind: "user-turn", text: "b" },
    ];
    const chunks = await hybrid.process(events, 0);
    // 2 verbatim + 1 summary = 3
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.type).toBe("episodic");
    expect(chunks[1]?.type).toBe("episodic");
    expect(chunks[2]?.type).toBe("aggregates");
    expect(chunks[2]?.content).toBe("user: a | user: b");
  });

  it("returns empty for empty buffer (no sub-writer calls)", async () => {
    let calls = 0;
    const counter: Writer = {
      async process() {
        calls++;
        return [];
      },
    };
    const hybrid = createHybridWriter([counter]);
    const chunks = await hybrid.process([], 0);
    expect(chunks).toEqual([]);
    expect(calls).toBe(0);
  });

  it("preserves order of sub-writers in output", async () => {
    const a: Writer = {
      async process() {
        return [{ type: "facts" as const, ordinal: 0, content: "from-a" }];
      },
    };
    const b: Writer = {
      async process() {
        return [{ type: "facts" as const, ordinal: 0, content: "from-b" }];
      },
    };
    const hybrid = createHybridWriter([a, b]);
    const chunks = await hybrid.process([{ kind: "user-turn", text: "x" }], 0);
    expect(chunks.map((c) => c.content)).toEqual(["from-a", "from-b"]);
  });

  it("makes verbatim chunks retrievable alongside extracted-style chunks via memory", async () => {
    const hybrid = createHybridWriter([verbatimWriter, summarizingStub]);
    const memory = await createOurMemory({ ...memOpts(), writer: hybrid });
    try {
      await memory.record({ kind: "user-turn", text: "alpha quick brown fox" });
      await memory.record({ kind: "assistant-turn", text: "beta lazy dog jumps" });
      const r = await memory.retrieve({ query: "alpha" });
      // We expect the verbatim turn-chunk to surface; both verbatim
      // and summary are now `kind: "memory"` since the markdown store
      // owns disk persistence.
      expect(r.items.length).toBeGreaterThanOrEqual(1);
      const sources = r.items.map((i) => i.source);
      expect(sources.some((s) => s.kind === "memory")).toBe(true);
    } finally {
      await memory.close?.();
    }
  });
});

describe("createFactCache", () => {
  function withTempDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "fact-cache-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const sampleFacts: Fact[] = [
    { type: "fact", content: "user lives in London" },
    { type: "preference", content: "loves coffee", entities: ["coffee"] },
  ];
  const group: WriteEvent[] = [
    { kind: "user-turn", text: "I live in London and love coffee" },
    { kind: "assistant-turn", text: "Got it." },
  ];

  it("returns undefined on miss, stores on set, returns facts on subsequent get", () => {
    withTempDir((dir) => {
      const cache = createFactCache({ cacheDir: dir, cacheKey: "test:v1" });
      expect(cache.get(group)).toBeUndefined();
      expect(cache.misses).toBe(1);
      cache.set(group, sampleFacts);
      const hit = cache.get(group);
      expect(hit).toEqual(sampleFacts);
      expect(cache.hits).toBe(1);
    });
  });

  it("namespaces by cacheKey: different keys do not see each other's entries", () => {
    withTempDir((dir) => {
      const a = createFactCache({ cacheDir: dir, cacheKey: "model-a:v1" });
      const b = createFactCache({ cacheDir: dir, cacheKey: "model-b:v1" });
      a.set(group, sampleFacts);
      expect(b.get(group)).toBeUndefined();
      expect(a.get(group)).toEqual(sampleFacts);
    });
  });

  it("different groups produce different keys", () => {
    withTempDir((dir) => {
      const cache = createFactCache({ cacheDir: dir, cacheKey: "test:v1" });
      const altGroup: WriteEvent[] = [{ kind: "user-turn", text: "different" }];
      cache.set(group, sampleFacts);
      expect(cache.get(altGroup)).toBeUndefined();
    });
  });

  it("survives across cache instances pointing at the same dir", () => {
    withTempDir((dir) => {
      const first = createFactCache({ cacheDir: dir, cacheKey: "test:v1" });
      first.set(group, sampleFacts);
      const second = createFactCache({ cacheDir: dir, cacheKey: "test:v1" });
      expect(second.get(group)).toEqual(sampleFacts);
    });
  });
});
