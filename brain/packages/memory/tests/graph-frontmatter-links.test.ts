import { describe, expect, it } from "vitest";
import { extractFrontmatterEdges } from "../src/graph/frontmatter-links.ts";

describe("extractFrontmatterEdges", () => {
  it("emits one mentions edge per entity", () => {
    const edges = extractFrontmatterEdges({
      fromChunkId: "c1",
      frontmatter: { entities: ["Sarah", "Mike"] },
    });
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.toEntity).sort()).toEqual(["mike", "sarah"]);
    expect(edges.every((e) => e.linkSource === "frontmatter")).toBe(true);
    expect(edges.every((e) => e.linkType === "mentions")).toBe(true);
  });

  it("emits covers_topic edges from topics field", () => {
    const edges = extractFrontmatterEdges({
      fromChunkId: "c1",
      frontmatter: { topics: ["wedding", "family"] },
    });
    expect(edges.map((e) => e.linkType)).toEqual(["covers_topic", "covers_topic"]);
    expect(edges.map((e) => e.toEntity).sort()).toEqual(["family", "wedding"]);
  });

  it("recognises supersedes / superseded_by", () => {
    const edges = extractFrontmatterEdges({
      fromChunkId: "c-new",
      frontmatter: { supersedes: ["[[prefers-decaf-2024-01-01]]"] },
      resolveSlug: (s) => (s === "prefers-decaf-2024-01-01" ? "c-old" : undefined),
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.linkType).toBe("supersedes");
    expect(edges[0]?.toChunkId).toBe("c-old");
  });

  it("dedupes equal (target, type) tuples", () => {
    const edges = extractFrontmatterEdges({
      fromChunkId: "c1",
      frontmatter: { entities: ["Sarah", "sarah", "SARAH"] },
    });
    expect(edges).toHaveLength(1);
  });

  it("treats attendees field as attended edges", () => {
    const edges = extractFrontmatterEdges({
      fromChunkId: "c1",
      frontmatter: { attendees: ["Sarah", "Mike"] },
    });
    expect(edges.every((e) => e.linkType === "attended")).toBe(true);
  });

  it("ignores empty / non-array fields", () => {
    expect(
      extractFrontmatterEdges({
        fromChunkId: "c1",
        frontmatter: { entities: [], topics: "" },
      }),
    ).toHaveLength(0);
  });
});
