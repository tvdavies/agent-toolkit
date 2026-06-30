import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { MarkdownMemoryRepository, SqliteMemoryIndex } from "./core-adapters.js";
import { createMarkdownStore } from "./storage/markdown-store.js";
import { createSqliteStorage } from "./storage/sqlite.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "brain-core-adapter-"));
  tempDirs.push(dir);
  return dir;
}

test("markdown repository put/get/list/delete round-trips documents", async () => {
  const rootDir = await tempRoot();
  const repo = new MarkdownMemoryRepository({
    store: createMarkdownStore({ rootDir }),
    scope: "test",
  });
  await repo.put({
    id: "doc-1",
    type: "facts",
    body: "Tom likes clean TypeScript.",
    metadata: { entities: ["Tom"], sourceKind: "test" },
    provenance: { source: "test", createdAt: "2026-01-01T00:00:00.000Z" },
  });

  expect((await repo.get("doc-1"))?.body).toBe("Tom likes clean TypeScript.");
  expect((await repo.list({ types: ["facts"] })).map((doc) => doc.id)).toEqual(["doc-1"]);

  await repo.updateMetadata("doc-1", { priority: "high" });
  expect((await repo.get("doc-1"))?.metadata.priority).toBe("high");

  await repo.delete("doc-1");
  expect(await repo.get("doc-1")).toBeUndefined();
});

test("sqlite index rebuilds from repository", async () => {
  const rootDir = await tempRoot();
  const repo = new MarkdownMemoryRepository({
    store: createMarkdownStore({ rootDir }),
    scope: "test",
  });
  const storage = createSqliteStorage({ dbPath: ":memory:" });
  const index = new SqliteMemoryIndex({ storage });
  try {
    await repo.put({
      id: "doc-2",
      type: "facts",
      body: "Gamma project uses green widgets.",
      metadata: {},
      provenance: { source: "test", createdAt: "2026-01-01T00:00:00.000Z" },
    });

    const report = await index.rebuildFrom(repo);
    const hits = await index.searchText({ query: "green widgets", limit: 5 });

    expect(report).toMatchObject({ documentsRead: 1, documentsIndexed: 1, errors: [] });
    expect(hits[0]?.id).toBe("doc-2");
  } finally {
    await storage.close();
  }
});

test("sqlite index upsert and text search returns hydrated candidates", async () => {
  const storage = createSqliteStorage({ dbPath: ":memory:" });
  const index = new SqliteMemoryIndex({ storage });
  try {
    await index.upsert({
      id: "doc-1",
      type: "facts",
      body: "Alpha project uses red widgets.",
      metadata: { tag: "alpha" },
      provenance: { source: "test", createdAt: "2026-01-01T00:00:00.000Z" },
    });

    const hits = await index.searchText({ query: "red widgets", limit: 5 });

    expect(hits[0]?.id).toBe("doc-1");
    expect(hits[0]?.document?.body).toBe("Alpha project uses red widgets.");
  } finally {
    await storage.close();
  }
});
