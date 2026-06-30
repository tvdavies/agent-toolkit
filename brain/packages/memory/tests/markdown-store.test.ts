import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMarkdownStore } from "../src/storage/markdown-store.ts";

describe("createMarkdownStore", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "memstore-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("writes a file at <root>/<scope>/<type>/<slug>.md", async () => {
    const store = createMarkdownStore({ rootDir });
    const result = await store.write({
      scope: "user/joe",
      type: "facts",
      body: "User attended Sarah and Mike's wedding",
      frontmatter: { id: "abc", type: "fact" },
      recordedAt: "2024-03-15",
    });
    expect(result.filePath).toBe(
      join(rootDir, "user/joe/facts/attended-sarah-mike-wedding-2024-03-15.md"),
    );
    expect(result.scope).toBe("user/joe");
    expect(result.type).toBe("facts");
    expect(result.slug).toBe("attended-sarah-mike-wedding-2024-03-15");
    const onDisk = readFileSync(result.filePath, "utf8");
    expect(onDisk).toContain("---");
    expect(onDisk).toContain("id: abc");
    expect(onDisk).toContain("User attended Sarah and Mike's wedding");
  });

  it("reuses the path on identical-body retry (idempotent persist)", async () => {
    // BRAIN-180: when the daemon crashes between markdownStore.write
    // and storage.upsertChunks, the queue retries the event. The
    // writer regenerates identical chunks; we must reuse the existing
    // file rather than create slug-2/slug-3 duplicates that pollute
    // the source of truth.
    const store = createMarkdownStore({ rootDir });
    const first = await store.write({
      scope: "test",
      type: "facts",
      body: "User likes coffee",
      frontmatter: { id: "first-attempt" },
    });
    const second = await store.write({
      scope: "test",
      type: "facts",
      body: "User likes coffee",
      frontmatter: { id: "retry-attempt" },
    });
    expect(second.filePath).toBe(first.filePath);
    expect(second.slug).toBe("likes-coffee");
    // The retry overwrites frontmatter so disk matches the live
    // chunk id (storage mints a fresh nanoid per call).
    const onDisk = readFileSync(first.filePath, "utf8");
    expect(onDisk).toContain("id: retry-attempt");
    expect(onDisk).not.toContain("id: first-attempt");
  });

  it("disambiguates real collisions (different body, same slug) with -2, -3", async () => {
    // Real slug collisions happen when two unrelated bodies normalise
    // to the same slug after stop-word + punctuation stripping. The
    // historical `-2`, `-3` suffix path still applies in that case.
    const store = createMarkdownStore({ rootDir });
    const a = await store.write({
      scope: "test",
      type: "facts",
      body: "User likes coffee!",
      frontmatter: { id: "a" },
    });
    const b = await store.write({
      scope: "test",
      type: "facts",
      body: "User likes coffee.",
      frontmatter: { id: "b" },
    });
    const c = await store.write({
      scope: "test",
      type: "facts",
      body: "User likes coffee?",
      frontmatter: { id: "c" },
    });
    expect(a.slug).toBe("likes-coffee");
    expect(b.slug).toBe("likes-coffee-2");
    expect(c.slug).toBe("likes-coffee-3");
  });

  it("round-trips a file through write + read", async () => {
    const store = createMarkdownStore({ rootDir });
    const written = await store.write({
      scope: "test",
      type: "preferences",
      body: "User prefers decaf",
      frontmatter: { id: "p1", entities: ["coffee"], topics: [] },
    });
    const read = await store.read(written.filePath);
    expect(read.scope).toBe("test");
    expect(read.type).toBe("preferences");
    expect(read.slug).toBe("prefers-decaf");
    expect(read.body).toBe("User prefers decaf");
    expect(read.frontmatter).toEqual({ id: "p1", entities: ["coffee"], topics: [] });
  });

  it("lists files in a scope filtered by type", async () => {
    const store = createMarkdownStore({ rootDir });
    await store.write({ scope: "s", type: "facts", body: "A fact", frontmatter: { id: "1" } });
    await store.write({ scope: "s", type: "facts", body: "B fact", frontmatter: { id: "2" } });
    await store.write({
      scope: "s",
      type: "preferences",
      body: "A pref",
      frontmatter: { id: "3" },
    });

    const allFacts = await store.list("s", "facts");
    expect(allFacts).toHaveLength(2);
    expect(allFacts.every((p) => p.includes("/facts/"))).toBe(true);

    const allInScope = await store.list("s");
    expect(allInScope).toHaveLength(3);
  });

  it("lists empty when scope or type doesn't exist", async () => {
    const store = createMarkdownStore({ rootDir });
    expect(await store.list("nonexistent", "facts")).toEqual([]);
    expect(await store.list("nonexistent")).toEqual([]);
  });

  it("deletes a file when given a valid path", async () => {
    const store = createMarkdownStore({ rootDir });
    const w = await store.write({
      scope: "s",
      type: "facts",
      body: "Disposable",
      frontmatter: { id: "d" },
    });
    await store.delete(w.filePath);
    expect(await store.list("s", "facts")).toEqual([]);
  });

  it("rejects deletion outside rootDir", async () => {
    const store = createMarkdownStore({ rootDir });
    await expect(store.delete("/etc/passwd")).rejects.toThrow(/outside rootDir/);
  });

  it("sanitises traversal sequences in scope", async () => {
    const store = createMarkdownStore({ rootDir });
    const result = await store.write({
      scope: "../../../etc",
      type: "facts",
      body: "Hello world",
      frontmatter: { id: "x" },
    });
    expect(result.filePath.startsWith(rootDir)).toBe(true);
    expect(result.filePath).not.toContain("/../");
    expect(result.filePath).toContain("etc/facts");
  });

  it("supports nested scopes like user/joe", async () => {
    const store = createMarkdownStore({ rootDir });
    const w = await store.write({
      scope: "user/joe",
      type: "facts",
      body: "User owns a golden retriever named Rex",
      frontmatter: { id: "1" },
    });
    expect(w.scope).toBe("user/joe");
    expect(w.filePath.endsWith("user/joe/facts/owns-golden-retriever-named-rex.md")).toBe(true);
    const r = await store.read(w.filePath);
    expect(r.scope).toBe("user/joe");
  });

  it("requires absolute rootDir", () => {
    expect(() => createMarkdownStore({ rootDir: "relative/path" })).toThrow(/absolute/);
  });
});
