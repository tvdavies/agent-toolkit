import { describe, expect, it } from "vitest";
import { createHeuristicReranker } from "../src/retrieval/heuristic-rerank.ts";
import type { RetrievalHit } from "../src/retrieval/types.ts";
import type { Chunk } from "../src/storage/types.ts";

/**
 * Build a unit vector pointing in a fixed angular direction. With two
 * dims `[cos(t), sin(t)]` the cosine between two such vectors is
 * `cos(t1 - t2)` — easy to control similarity in tests.
 */
function angledEmbedding(theta: number): Float32Array {
  return new Float32Array([Math.cos(theta), Math.sin(theta)]);
}

function hit(id: string, content: string, score: number, theta?: number): RetrievalHit {
  const chunk: Chunk = {
    id,
    path: `/test/${id}.md`,
    type: "facts",
    ordinal: 0,
    content,
    ...(theta !== undefined ? { embedding: angledEmbedding(theta) } : {}),
  };
  return { chunk, score };
}

describe("createHeuristicReranker", () => {
  it("preserves order when all hits are dissimilar", async () => {
    // 3 vectors at 0, π/2, π — pairwise cos is 0, 0, -1. No MMR penalty fires.
    const reranker = createHeuristicReranker();
    const hits = [
      hit("a", "alpha", 0.9, 0),
      hit("b", "bravo", 0.7, Math.PI / 2),
      hit("c", "charlie", 0.5, Math.PI),
    ];
    const out = await reranker.rerank("any", hits, 3);
    expect(out.map((h) => h.chunk.id)).toEqual(["a", "b", "c"]);
  });

  it("hard-skips a near-duplicate (cosine >= 0.92)", async () => {
    // a and b are nearly parallel (cosine ~ 0.995). c is orthogonal.
    // With dup threshold 0.92, b should be skipped after a is selected.
    const reranker = createHeuristicReranker();
    const hits = [
      hit("a", "the same thing", 0.9, 0),
      hit("b", "almost the same", 0.85, 0.1),
      hit("c", "different", 0.4, Math.PI / 2),
    ];
    const out = await reranker.rerank("any", hits, 3);
    expect(out.map((h) => h.chunk.id)).toEqual(["a", "c"]);
    // b was hard-dropped — it's not in the result at all (window only).
    expect(out.find((h) => h.chunk.id === "b")).toBeUndefined();
  });

  it("applies soft MMR for cosine in [mmrFloor, duplicateThreshold)", async () => {
    // a at 0, b at angle yielding cosine ~ 0.8 (between mmrFloor 0.7 and 0.92),
    // c orthogonal. b's score gets penalised by 1 - 0.3*0.8 = 0.76.
    // Without penalty: a=1.0, b=0.95, c=0.5 → order a, b, c.
    // With penalty:    a=1.0, b=0.95*0.76=0.722, c=0.5 → still a, b, c BUT
    //                  c could overtake b if b's score is closer.
    // Use closer scores so the penalty actually matters:
    // a=1.0, b=0.7, c=0.65. Without: a, b, c. With penalty:
    //   b' = 0.7 * 0.76 = 0.532 → c (0.65) overtakes → order a, c, b.
    const cosOf08 = Math.acos(0.8);
    const reranker = createHeuristicReranker();
    const hits = [
      hit("a", "topic primary", 1.0, 0),
      hit("b", "topic secondary", 0.7, cosOf08),
      hit("c", "different topic", 0.65, Math.PI / 2),
    ];
    const out = await reranker.rerank("any", hits, 3);
    expect(out.map((h) => h.chunk.id)).toEqual(["a", "c", "b"]);
  });

  it("hits without embeddings still rank by score (no MMR signal)", async () => {
    const reranker = createHeuristicReranker();
    const hits = [
      hit("a", "high score, no embed", 0.9), // no embedding
      hit("b", "low score, no embed", 0.3),
      hit("c", "mid score, has embed", 0.6, 0),
    ];
    const out = await reranker.rerank("any", hits, 3);
    expect(out.map((h) => h.chunk.id)).toEqual(["a", "c", "b"]);
  });

  it("falls back to fused tail when window deduplicates below topK", async () => {
    // windowK=2, all in window are duplicates → only 1 selected; tail
    // fills in fused order.
    const reranker = createHeuristicReranker({ windowK: 2 });
    const hits = [
      hit("a", "same thing", 0.9, 0),
      hit("b", "same thing", 0.85, 0.05), // near-dup of a, dropped
      hit("c", "tail item", 0.5, Math.PI / 2),
      hit("d", "later tail", 0.4, Math.PI),
    ];
    const out = await reranker.rerank("any", hits, 3);
    expect(out.map((h) => h.chunk.id)).toEqual(["a", "c", "d"]);
  });

  it("returns empty for empty input", async () => {
    const reranker = createHeuristicReranker();
    expect(await reranker.rerank("any", [], 5)).toEqual([]);
  });

  it("single-hit input passes through unchanged", async () => {
    const reranker = createHeuristicReranker();
    const hits = [hit("a", "only one", 0.8, 0)];
    const out = await reranker.rerank("any", hits, 5);
    expect(out).toEqual(hits.slice(0, 5));
  });

  it("respects topK truncation", async () => {
    const reranker = createHeuristicReranker();
    const hits = [
      hit("a", "first", 0.9, 0),
      hit("b", "second", 0.7, Math.PI / 2),
      hit("c", "third", 0.5, Math.PI),
    ];
    const out = await reranker.rerank("any", hits, 2);
    expect(out).toHaveLength(2);
    expect(out.map((h) => h.chunk.id)).toEqual(["a", "b"]);
  });

  it("disabled MMR (lambda=0) preserves order even with similar hits", async () => {
    const reranker = createHeuristicReranker({ mmrLambda: 0 });
    const cosOf08 = Math.acos(0.8);
    const hits = [
      hit("a", "primary", 1.0, 0),
      hit("b", "secondary close", 0.7, cosOf08),
      hit("c", "different", 0.65, Math.PI / 2),
    ];
    const out = await reranker.rerank("any", hits, 3);
    expect(out.map((h) => h.chunk.id)).toEqual(["a", "b", "c"]);
  });
});
