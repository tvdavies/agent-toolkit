import { describe, expect, it } from "vitest";
import {
  extractEntityMentions,
  extractPageEdges,
  extractWikilinks,
  inferLinkType,
} from "../src/graph/link-inference.ts";

describe("inferLinkType", () => {
  it("matches per-edge verbs ahead of category default", () => {
    expect(inferLinkType("User attended Sarah's wedding on March 15", "facts")).toBe("attended");
    expect(inferLinkType("User decided to switch to Acme", "facts")).toBe("decided");
    expect(inferLinkType("User prefers decaf coffee", "facts")).toBe("prefers");
    expect(inferLinkType("User dislikes mushrooms", "facts")).toBe("dislikes");
    expect(inferLinkType("User bought a new TV", "facts")).toBe("owns");
    expect(inferLinkType("User visited Sonoma last weekend", "facts")).toBe("visited");
    expect(inferLinkType("User met up with Bob for coffee", "facts")).toBe("met");
    expect(inferLinkType("User watched the new Marvel film", "facts")).toBe("consumed_media");
    expect(inferLinkType("User cooked risotto for dinner", "facts")).toBe("consumed");
  });

  it("falls back to category default when no verb matches", () => {
    expect(inferLinkType("Something about Sarah here.", "events")).toBe("attended");
    expect(inferLinkType("Something about Sarah here.", "preferences")).toBe("prefers");
    expect(inferLinkType("Something about Sarah here.", "decisions")).toBe("decided");
    expect(inferLinkType("Something about Sarah here.", "facts")).toBe("mentions");
    expect(inferLinkType("Something about Sarah here.", "aggregates")).toBe("summarises");
  });

  it("specific verbs win over generic preference", () => {
    // 'liked' would otherwise match PREFERS, but 'attended' is more specific.
    expect(inferLinkType("User attended and liked Sarah's wedding", "facts")).toBe("attended");
  });
});

describe("extractWikilinks", () => {
  it("captures unqualified [[slug]]", () => {
    const refs = extractWikilinks("See also [[wedding-2024-03-15]] for context.");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ targetSlug: "wedding-2024-03-15" });
  });

  it("captures [[scope:slug]]", () => {
    const refs = extractWikilinks("Cross-ref: [[user/joe:wedding-2024-03-15]] noted.");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ scope: "user/joe", targetSlug: "wedding-2024-03-15" });
  });

  it("captures [[slug|Display Name]]", () => {
    const refs = extractWikilinks("[[wedding-2024-03-15|Sarah's wedding]] was lovely.");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      targetSlug: "wedding-2024-03-15",
      displayName: "Sarah's wedding",
    });
  });

  it("scoped + unscoped don't double-count the same span", () => {
    const refs = extractWikilinks("First [[user/joe:foo]] then plain [[bar]].");
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.targetSlug)).toEqual(["foo", "bar"]);
  });

  it("ignores wikilinks inside fenced code blocks", () => {
    const body = "Real one: [[real]]\n```\nfake [[ignored-in-code]]\n```\n";
    const refs = extractWikilinks(body);
    expect(refs.map((r) => r.targetSlug)).toEqual(["real"]);
  });

  it("ignores wikilinks inside inline code", () => {
    const body = "Use `[[not-a-link]]` syntax. Real: [[real]]";
    expect(extractWikilinks(body).map((r) => r.targetSlug)).toEqual(["real"]);
  });

  it("skips URLs", () => {
    expect(extractWikilinks("[[https://example.com]] and [[real]]").length).toBe(1);
  });
});

describe("extractEntityMentions", () => {
  it("returns one mention per entity", () => {
    const m = extractEntityMentions("User attended Sarah and Mike's wedding.", ["Sarah", "Mike"]);
    expect(m).toHaveLength(2);
    expect(m[0]?.entity).toBe("Sarah");
    expect(m[1]?.entity).toBe("Mike");
  });

  it("dedupes case-insensitively", () => {
    const m = extractEntityMentions("user mentions sarah and Sarah twice", ["Sarah", "sarah"]);
    expect(m).toHaveLength(1);
  });

  it("falls back to body prefix when entity not in body", () => {
    const m = extractEntityMentions("Some unrelated content", ["Sarah"]);
    expect(m).toHaveLength(1);
    expect(m[0]?.context).toContain("Some unrelated");
  });
});

describe("extractPageEdges", () => {
  it("emits one edge per entity with type inferred from category", () => {
    const edges = extractPageEdges({
      fromChunkId: "chunk-1",
      body: "User attended Sarah and Mike's wedding on March 15.",
      type: "events",
      entities: ["Sarah", "Mike"],
    });
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.fromChunkId === "chunk-1")).toBe(true);
    expect(edges.every((e) => e.linkType === "attended")).toBe(true);
    expect(edges.map((e) => e.toEntity)).toEqual(["sarah", "mike"]);
    expect(edges.every((e) => e.linkSource === "markdown")).toBe(true);
  });

  it("resolves wikilink slugs to chunk ids when resolver matches", () => {
    const edges = extractPageEdges({
      fromChunkId: "chunk-1",
      body: "See [[wedding-2024-03-15]].",
      type: "facts",
      resolveSlug: (s) => (s === "wedding-2024-03-15" ? "chunk-99" : undefined),
    });
    const wikiEdge = edges.find((e) => e.linkSource === "wikilink");
    expect(wikiEdge).toBeDefined();
    expect(wikiEdge?.toChunkId).toBe("chunk-99");
    expect(wikiEdge?.toEntity).toBeUndefined();
  });

  it("falls back to entity edge when wikilink doesn't resolve", () => {
    const edges = extractPageEdges({
      fromChunkId: "chunk-1",
      body: "See [[unknown-target]].",
      type: "facts",
    });
    const wikiEdge = edges.find((e) => e.linkSource === "wikilink");
    expect(wikiEdge?.toChunkId).toBeUndefined();
    expect(wikiEdge?.toEntity).toBe("unknown-target");
  });

  it("dedupes (target, type, source) tuples", () => {
    const edges = extractPageEdges({
      fromChunkId: "chunk-1",
      body: "Sarah attended. Sarah also won.",
      type: "events",
      entities: ["Sarah", "Sarah"],
    });
    expect(edges).toHaveLength(1);
  });
});
