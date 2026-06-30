import { describe, expect, it } from "vitest";
import { EntityIndex, extractQueryEntities } from "../src/retrieval/entity.ts";

describe("extractQueryEntities", () => {
  it("extracts a bare proper noun", () => {
    expect(extractQueryEntities("Did Alex come to the party?")).toContain("alex");
  });

  it("extracts multi-word proper nouns", () => {
    const r = extractQueryEntities("Have I been to New York lately?");
    expect(r).toContain("new york");
  });

  it("captures '<name> from <place>' qualifier", () => {
    const r = extractQueryEntities("How many times have I met up with Alex from Germany?");
    expect(r).toContain("alex");
    expect(r).toContain("alex from germany");
  });

  it("strips first-person pronouns and common stopwords", () => {
    const r = extractQueryEntities("How many days a week do I attend fitness classes?");
    // "I" is a stopword; "Have/How" too. Expect no false positives.
    expect(r).not.toContain("i");
    expect(r).not.toContain("have");
  });

  it("returns empty list when no proper nouns", () => {
    expect(extractQueryEntities("how many bananas do i eat each day")).toEqual([]);
  });

  it("dedupes identical entities mentioned twice", () => {
    const r = extractQueryEntities("Did Alex see Alex at the party?");
    expect(r).toEqual(["alex"]);
  });
});

describe("EntityIndex", () => {
  it("returns empty when no entities indexed", () => {
    const idx = new EntityIndex();
    expect(idx.findChunksByQueryEntities(["alex"])).toEqual(new Set());
    expect(idx.size()).toBe(0);
  });

  it("indexes and retrieves a single entity-chunk pair", () => {
    const idx = new EntityIndex();
    idx.add("chunk-1", ["Alex"]);
    expect(idx.findChunksByQueryEntities(["alex"])).toEqual(new Set(["chunk-1"]));
  });

  it("matches qualified query against bare indexed entity (Alex matches when query says Alex from Germany)", () => {
    const idx = new EntityIndex();
    idx.add("chunk-1", ["Alex"]);
    // Query has both "alex" and "alex from germany"; bare "alex" indexed
    // matches as a prefix of "alex from germany" → chunk surfaces.
    const matches = idx.findChunksByQueryEntities(["alex", "alex from germany"]);
    expect(matches).toEqual(new Set(["chunk-1"]));
  });

  it("matches bare query against qualified indexed entity (substring match)", () => {
    const idx = new EntityIndex();
    idx.add("chunk-1", ["Alex from Germany"]);
    expect(idx.findChunksByQueryEntities(["alex"])).toEqual(new Set(["chunk-1"]));
  });

  it("unions chunk ids across matching entities", () => {
    const idx = new EntityIndex();
    idx.add("chunk-1", ["Alex"]);
    idx.add("chunk-2", ["Alex from Germany"]);
    idx.add("chunk-3", ["Bob"]);
    const matches = idx.findChunksByQueryEntities(["alex"]);
    expect(matches).toEqual(new Set(["chunk-1", "chunk-2"]));
  });

  it("ignores non-matching query entities", () => {
    const idx = new EntityIndex();
    idx.add("chunk-1", ["Alex"]);
    expect(idx.findChunksByQueryEntities(["sarah"])).toEqual(new Set());
  });

  it("treats add() as additive — same chunk re-added doesn't duplicate", () => {
    const idx = new EntityIndex();
    idx.add("chunk-1", ["Alex"]);
    idx.add("chunk-1", ["Alex"]);
    expect(idx.findChunksByQueryEntities(["alex"])).toEqual(new Set(["chunk-1"]));
  });

  it("size and chunksFor expose diagnostics", () => {
    const idx = new EntityIndex();
    idx.add("chunk-1", ["Alex", "Sarah"]);
    idx.add("chunk-2", ["Alex"]);
    expect(idx.size()).toBe(2);
    expect(idx.chunksFor("Alex")).toBe(2);
    expect(idx.chunksFor("Sarah")).toBe(1);
  });
});
