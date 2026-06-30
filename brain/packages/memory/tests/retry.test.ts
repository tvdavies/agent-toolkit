import { describe, expect, test } from "bun:test";
import { searchBM25WithRetry, strongestTerm } from "../src/retrieval/retry.js";
import { createSqliteStorage } from "../src/storage/sqlite.js";

describe("BM25 retry ladder", () => {
  test("extracts strongest significant term for fallback rung", () => {
    expect(strongestTerm("what beverage recommendation should I remember")).toBe("recommendation");
  });

  test("falls back to fuzzy slug trigram when body has no lexical match", () => {
    const storage = createSqliteStorage();
    storage.upsertChunk({
      id: "c1",
      path: "/tmp/preferences/user-preference-pacific-crest-trail.md",
      type: "preferences",
      ordinal: 1,
      content: "User wants a thru-hike reminder.",
    });

    const result = searchBM25WithRetry(storage, "pacific crest", 5);

    expect(result.hits.map((h) => h.chunk.id)).toEqual(["c1"]);
    expect(result.attempts.at(-1)?.rung).toBe("slug-trigram");
  });
});
