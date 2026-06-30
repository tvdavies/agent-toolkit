import { describe, expect, it } from "vitest";
import { applyDensityBoost, countLiteralDetails } from "../src/retrieval/density.ts";
import { selectMMR } from "../src/retrieval/mmr.ts";
import type { RetrievalHit } from "../src/retrieval/types.ts";

describe("countLiteralDetails", () => {
  it("counts ISO dates", () => {
    expect(countLiteralDetails("the user attended on 2024-03-15")).toBeGreaterThanOrEqual(1);
  });

  it("counts month-name dates", () => {
    expect(countLiteralDetails("happened on March 15, 2024")).toBeGreaterThanOrEqual(1);
    expect(countLiteralDetails("on Feb 1st they did it")).toBeGreaterThanOrEqual(1);
  });

  it("counts monetary amounts", () => {
    expect(countLiteralDetails("raised $5,000 for charity")).toBeGreaterThanOrEqual(1);
    expect(countLiteralDetails("£45 budget")).toBeGreaterThanOrEqual(1);
    expect(countLiteralDetails("12.5k allocated")).toBeGreaterThanOrEqual(1);
  });

  it("counts plain numbers ≥ 2", () => {
    expect(countLiteralDetails("attended 3 weddings")).toBeGreaterThanOrEqual(1);
    expect(countLiteralDetails("there were 27 events")).toBeGreaterThanOrEqual(1);
  });

  it("returns 0 for content with no literal details", () => {
    expect(countLiteralDetails("the user enjoyed the experience")).toBe(0);
  });
});

describe("applyDensityBoost", () => {
  it("boosts score proportional to detail count", () => {
    const baseline = applyDensityBoost(1, "no details here");
    const dense = applyDensityBoost(1, "on March 15, 2024 spent $500 over 3 weeks");
    expect(dense).toBeGreaterThan(baseline);
  });

  it("returns score unchanged for empty content", () => {
    expect(applyDensityBoost(1, "")).toBe(1);
  });

  it("caps the boost so dense chunks don't dominate", () => {
    const veryDense =
      "on 2024-03-15 spent $500 then on 2024-04-20 spent $1000 then on 2024-05-30 spent $2000 then on 2024-06-15 spent $3000 then on 2024-07-20 spent $4000 totalling 100 events";
    const boosted = applyDensityBoost(1, veryDense, 0.15, 5);
    expect(boosted).toBeLessThanOrEqual(1.75);
  });
});

describe("selectMMR", () => {
  function hit(id: string, content: string, score: number): RetrievalHit {
    return {
      chunk: { id, path: `episodic/${id}.md`, ordinal: 0, content },
      score,
      contributions: { bm25: score },
    };
  }

  it("returns all hits when count <= topK", () => {
    const hits = [hit("a", "x", 1), hit("b", "y", 0.5)];
    expect(selectMMR(hits, 5).length).toBe(2);
  });

  it("first pick is the highest-score candidate", () => {
    const hits = [
      hit("a", "alpha unique tokens here", 0.5),
      hit("b", "beta different tokens", 0.9),
      hit("c", "gamma extra words", 0.7),
      hit("d", "delta yet more tokens", 0.4),
    ];
    const out = selectMMR(hits, 3);
    expect(out[0]?.chunk.id).toBe("b");
  });

  it("prefers diversity over score on near-duplicates", () => {
    // Three near-duplicates of one event + one different event. With
    // topK=2, MMR should pick (top-scoring duplicate, different event).
    const hits = [
      hit("dup1", "user attended Sarah Mike wedding March 2024", 0.95),
      hit("dup2", "user attended Sarah Mike wedding March 2024", 0.92),
      hit("dup3", "user attended Sarah Mike wedding March 2024", 0.9),
      hit("diff", "user attended Lisa James wedding June 2024", 0.6),
    ];
    const out = selectMMR(hits, 2, 0.5);
    expect(out.map((h) => h.chunk.id).sort()).toEqual(["diff", "dup1"]);
  });

  it("with lambda=1 reduces to pure score sort", () => {
    const hits = [
      hit("a", "content one", 0.9),
      hit("b", "content one", 0.85), // near-duplicate
      hit("c", "different stuff entirely", 0.5),
    ];
    const out = selectMMR(hits, 2, 1.0);
    expect(out.map((h) => h.chunk.id)).toEqual(["a", "b"]);
  });
});
