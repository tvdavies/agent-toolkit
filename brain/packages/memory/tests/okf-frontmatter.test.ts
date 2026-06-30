import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOurMemory } from "../src/memory.ts";
import { createMarkdownStore } from "../src/storage/markdown-store.ts";
import { deriveOkfTitle } from "../src/storage/okf.ts";

describe("deriveOkfTitle", () => {
  it("prefers an explicit source title", () => {
    expect(deriveOkfTitle("some body content", "#team thread")).toBe("#team thread");
  });

  it("distils the first meaningful line, stripping role prefixes and markers", () => {
    expect(deriveOkfTitle("user: Riley prefers integration tests")).toBe(
      "Riley prefers integration tests",
    );
    expect(deriveOkfTitle("# Heading line\nmore")).toBe("Heading line");
    expect(deriveOkfTitle("- a bullet point")).toBe("a bullet point");
  });

  it("truncates long content at a word boundary with an ellipsis", () => {
    const long =
      "This is a deliberately long memory statement that goes well beyond the title length limit for sure";
    const title = deriveOkfTitle(long);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith("…")).toBe(true);
    expect(long.startsWith(title.slice(0, -1).trimEnd())).toBe(true);
  });

  it("falls back to 'Memory' for empty content", () => {
    expect(deriveOkfTitle("   \n  ")).toBe("Memory");
  });
});

describe("OKF frontmatter is the default on the write path", () => {
  let rootDir: string;
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "okf-e2e-"));
  });
  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it("writes type/title/timestamp (OKF core) while preserving native keys", async () => {
    const memory = await createOurMemory({ rootDir, scope: "test" });
    try {
      await memory.record({
        kind: "ingested-item",
        source: { kind: "slack", id: "C1/9", title: "Standup notes" },
        content: "Riley chose the provenance envelope shape for connectors.",
        recordedAt: "2026-05-15T12:00:00Z",
      });
      await memory.retrieve({ query: "provenance envelope", skipEmbed: true });
    } finally {
      await memory.close?.();
    }

    const store = createMarkdownStore({ rootDir });
    const paths = await store.list("test", "observations");
    const file = paths[0] ? await store.read(paths[0]) : undefined;
    expect(file).toBeDefined();
    const fm = file?.frontmatter ?? {};

    // OKF core fields.
    expect(fm.type).toBe("observations");
    expect(fm.title).toBe("Standup notes"); // sourced from the source-ref title
    expect(fm.timestamp).toBe("2026-05-15T12:00:00Z"); // OKF timestamp mirrors recordedAt

    // Native keys preserved for the index.
    expect(typeof fm.id).toBe("string");
    expect(fm.recordedAt).toBe("2026-05-15T12:00:00Z");
  });

  it("derives a title from content when no source title is present", async () => {
    const memory = await createOurMemory({ rootDir, scope: "test" });
    try {
      await memory.record({
        kind: "user-turn",
        text: "Tom prefers thorough answers that walk through tradeoffs.",
        recordedAt: "2026-05-16T09:00:00Z",
      });
      await memory.retrieve({ query: "answer style", skipEmbed: true });
    } finally {
      await memory.close?.();
    }

    const store = createMarkdownStore({ rootDir });
    // user turns persist under the episodic type.
    const types = ["episodic", "observations", "facts", "preferences"];
    let title: unknown;
    for (const type of types) {
      const paths = await store.list("test", type);
      if (paths[0]) {
        title = (await store.read(paths[0])).frontmatter.title;
        break;
      }
    }
    expect(typeof title).toBe("string");
    expect((title as string).length).toBeGreaterThan(0);
  });
});
