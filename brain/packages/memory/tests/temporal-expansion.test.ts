import { describe, expect, it } from "vitest";
import { expandTemporal } from "../src/retrieval/temporal-expansion.ts";

describe("expandTemporal", () => {
  it("resolves 'N weeks ago' against an LME-format anchor", () => {
    const r = expandTemporal("What did I do 2 weeks ago?", "2023/04/10 (Mon) 23:07");
    expect(r.resolved).toBe(true);
    expect(r.expandedQuery).toContain("2 weeks ago (around 2023/03/27)");
    expect(r.dateHints).toContain("2023/03/27");
  });

  it("resolves 'last Saturday' to the nearest preceding Saturday", () => {
    const r = expandTemporal("Did anything happen last Saturday?", "2023/04/10 (Mon) 23:07");
    expect(r.resolved).toBe(true);
    expect(r.expandedQuery).toContain("last Saturday (2023/04/08)");
    expect(r.dateHints).toContain("2023/04/08");
  });

  it("annotates ordering for 'first' queries", () => {
    const r = expandTemporal("What was the first thing I did?", "2023/04/10 (Mon) 23:07");
    expect(r.expandedQuery).toContain("[Note: look for the earliest dated event]");
  });

  it("annotates ordering for 'most recent' queries", () => {
    const r = expandTemporal("What was the most recent meeting?", "2023/04/10 (Mon) 23:07");
    expect(r.expandedQuery).toContain("[Note: look for the most recently dated event]");
  });

  it("returns the original query when anchor doesn't parse", () => {
    const r = expandTemporal("What did I do two weeks ago?", "garbage");
    expect(r.resolved).toBe(false);
    expect(r.expandedQuery).toBe("What did I do two weeks ago?");
  });

  it("returns the original query when no temporal references present", () => {
    const r = expandTemporal("What's my favourite colour?", "2023/04/10 (Mon) 23:07");
    expect(r.resolved).toBe(false);
    expect(r.expandedQuery).toBe("What's my favourite colour?");
  });

  it("handles ISO-8601 anchors", () => {
    const r = expandTemporal("What did I do 3 days ago?", "2023-04-10");
    expect(r.resolved).toBe(true);
    expect(r.dateHints[0]).toBe("2023/04/07");
  });
});
