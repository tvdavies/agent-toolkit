import { describe, expect, test } from "bun:test";
import {
  heuristicFallbackRewriter,
  shouldFallbackRewrite,
} from "../src/retrieval/fallback-rewrite.js";

describe("fallback query rewrite", () => {
  test("only runs when all candidate legs miss", () => {
    expect(shouldFallbackRewrite({ bm25Hits: 0, vectorHits: 0, entityHits: 0 })).toBe(true);
    expect(shouldFallbackRewrite({ bm25Hits: 1, vectorHits: 0, entityHits: 0 })).toBe(false);
  });

  test("heuristic rewriter strips question filler", async () => {
    await expect(
      heuristicFallbackRewriter.rewrite("what do you remember about Pacific Crest Trail"),
    ).resolves.toEqual(["you Pacific Crest Trail"]);
  });
});
