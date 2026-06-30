import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createOurMemory,
  type ExtensionCandidateGenerator,
  type ExtensionRanker,
  type ExtensionSelector,
} from "./memory.js";
import type { Writer } from "./write/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "brain-memory-ext-"));
  tempDirs.push(dir);
  return dir;
}

const fixedWriter: Writer = {
  async process(_events, baseOrdinal) {
    return [
      {
        id: "alpha-memory",
        type: "facts",
        ordinal: baseOrdinal,
        content: "Alpha project uses red widgets.",
        metadata: { tag: "alpha" },
      },
      {
        id: "beta-memory",
        type: "facts",
        ordinal: baseOrdinal + 1,
        content: "Beta project uses blue widgets.",
        metadata: { tag: "beta" },
      },
    ];
  },
};

test("writer pipeline persists chunks", async () => {
  const rootDir = await tempRoot();
  const memory = await createOurMemory({ rootDir, scope: "test", writer: fixedWriter });
  try {
    await memory.record({ kind: "user-turn", text: "ignored" });
    await memory.flush?.();
    const result = await memory.retrieve({ query: "red widgets", budget: { maxItems: 5 } });

    expect(result.items.map((item) => item.id)).toContain("alpha-memory");
  } finally {
    await memory.close?.();
  }
});

test("extension ranker can change recall ordering", async () => {
  const rootDir = await tempRoot();
  const ranker: ExtensionRanker = {
    id: "test/ranker",
    rank(candidates) {
      return candidates.map((candidate) => ({
        ...candidate,
        score: candidate.id === "beta-memory" ? candidate.score + 100 : candidate.score,
      }));
    },
  };
  const memory = await createOurMemory({
    rootDir,
    scope: "test",
    writer: fixedWriter,
    retrievalModules: ["brain/bm25", "brain/rrf", "test/ranker"],
    extensionRankers: [ranker],
  });
  try {
    await memory.record({ kind: "user-turn", text: "ignored" });
    const result = await memory.retrieve({ query: "widgets", budget: { maxItems: 2 } });

    expect(result.items[0]?.id).toBe("beta-memory");
  } finally {
    await memory.close?.();
  }
});

test("extension rankers run in configured order", async () => {
  const rootDir = await tempRoot();
  const first: ExtensionRanker = {
    id: "test/first-ranker",
    rank(candidates) {
      return candidates.map((candidate) => ({
        ...candidate,
        score: candidate.id === "alpha-memory" ? 1 : 10,
      }));
    },
  };
  const second: ExtensionRanker = {
    id: "test/second-ranker",
    rank(candidates) {
      return candidates.map((candidate) => ({
        ...candidate,
        score: candidate.id === "alpha-memory" ? 100 : candidate.score,
      }));
    },
  };
  const memory = await createOurMemory({
    rootDir,
    scope: "test",
    writer: fixedWriter,
    retrievalModules: ["brain/bm25", "brain/rrf", "test/first-ranker", "test/second-ranker"],
    extensionRankers: [first, second],
  });
  try {
    await memory.record({ kind: "user-turn", text: "ignored" });
    const result = await memory.retrieve({ query: "widgets", budget: { maxItems: 2 } });

    expect(result.items[0]?.id).toBe("alpha-memory");
  } finally {
    await memory.close?.();
  }
});

test("extension selector can filter final recall", async () => {
  const rootDir = await tempRoot();
  const selector: ExtensionSelector = {
    id: "test/selector",
    select(candidates) {
      return candidates.filter((candidate) => candidate.id === "alpha-memory");
    },
  };
  const memory = await createOurMemory({
    rootDir,
    scope: "test",
    writer: fixedWriter,
    retrievalModules: ["brain/bm25", "brain/rrf", "test/selector"],
    extensionSelectors: [selector],
  });
  try {
    await memory.record({ kind: "user-turn", text: "ignored" });
    const result = await memory.retrieve({ query: "widgets", budget: { maxItems: 2 } });

    expect(result.items.map((item) => item.id)).toEqual(["alpha-memory"]);
  } finally {
    await memory.close?.();
  }
});

test("extension candidate generator can add an indexed id", async () => {
  const rootDir = await tempRoot();
  const generator: ExtensionCandidateGenerator = {
    id: "test/generator",
    generate() {
      return [{ id: "beta-memory", score: 50, source: "test/generator" }];
    },
  };
  const memory = await createOurMemory({
    rootDir,
    scope: "test",
    writer: fixedWriter,
    retrievalModules: ["brain/bm25", "brain/rrf", "test/generator"],
    extensionCandidateGenerators: [generator],
  });
  try {
    await memory.record({ kind: "user-turn", text: "ignored" });
    const result = await memory.retrieve({ query: "red", budget: { maxItems: 2 } });

    expect(result.items.map((item) => item.id)).toContain("beta-memory");
  } finally {
    await memory.close?.();
  }
});
