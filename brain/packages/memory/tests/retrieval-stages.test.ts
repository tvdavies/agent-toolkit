import { describe, expect, test } from "bun:test";
import { planRetrieval, prepareRetrievalQuery } from "../src/retrieval/stages.js";

describe("retrieval stages", () => {
  test("prepareRetrievalQuery expands temporal references against anchor date", () => {
    const prepared = prepareRetrievalQuery({
      query: "what did I do 3 days ago",
      anchorDate: "2026-05-08T12:00:00Z",
    });
    expect(prepared.effectiveQuery).not.toBe(prepared.originalQuery);
    expect(prepared.temporalExpanded).toBe(true);
  });

  test("planRetrieval resolves pathBoostTopK for typed intents", () => {
    const plan = planRetrieval("when did I visit Rome", { query: "when did I visit Rome" }, 5, 12);
    expect(plan.intent.intent).toBe("temporal");
    expect(plan.topK).toBe(12);
  });
});
