import { describe, expect, it } from "vitest";
import { applyTypeMultiplier, classifyIntent } from "../src/retrieval/intent.ts";

describe("classifyIntent", () => {
  it("recognises temporal queries", () => {
    const queries = [
      "When did I go to the gym last?",
      "What date did I submit the form?",
      "On Feb 1 what did I order?",
      "What did I do on March 15th?",
      "in 2024 what was my favourite food",
      "anything happen yesterday?",
      "what happened last week",
      "when was the last time I went?",
      "did I go on Monday?",
      "Which gift did I buy first?",
      "Which item arrived earliest?",
      "What was my most recent purchase?",
      "How many days ago did I watch the movie?",
      "Two weeks ago I started a new project",
      "How many days passed between my visits?",
    ];
    for (const q of queries) {
      const r = classifyIntent(q);
      expect(r.intent, `query: ${q}`).toBe("temporal");
      expect(r.weights.vector).toBe(0);
      expect(r.weights.bm25).toBe(1);
      expect(r.pathMultipliers, `query: ${q}`).toBeDefined();
      expect(r.pathMultipliers?.events).toBeGreaterThan(1);
    }
  });

  it("recognises factoid queries", () => {
    const queries = [
      "How many items did I buy?",
      "How much did I pay?",
      "Where is the office located?",
      "Who is the project manager?",
      "Which day is best for the meeting?",
      "What is the exact address?",
      "What is the capital of France?",
    ];
    for (const q of queries) {
      const r = classifyIntent(q);
      expect(r.intent, `query: ${q}`).toBe("factoid");
      expect(r.weights.bm25).toBe(1);
      expect(r.weights.vector).toBe(0.3);
      expect(r.pathMultipliers?.facts).toBeGreaterThan(1);
    }
  });

  it("recognises preference queries", () => {
    const queries = [
      "What is my favourite food?",
      "What do I prefer for breakfast?",
      "Things I like to eat",
      "Do I love coffee?",
      "Activities I enjoy",
      "I usually drive in the morning",
    ];
    for (const q of queries) {
      const r = classifyIntent(q);
      expect(r.intent, `query: ${q}`).toBe("preference");
      expect(r.weights.vector).toBe(1);
      expect(r.weights.bm25).toBe(0.5);
      expect(r.pathMultipliers?.preferences).toBeGreaterThan(1);
    }
  });

  it("falls back to general/balanced weights for everything else", () => {
    const queries = [
      "tell me about the project",
      "summarise the meeting notes",
      "what did Alex think",
    ];
    for (const q of queries) {
      const r = classifyIntent(q);
      expect(r.intent, `query: ${q}`).toBe("general");
      expect(r.weights.bm25).toBe(1);
      expect(r.weights.vector).toBe(1);
      expect(r.pathMultipliers).toBeUndefined();
    }
  });

  it("temporal trumps factoid when both could match", () => {
    const r = classifyIntent("How many emails did I get yesterday?");
    expect(r.intent).toBe("temporal");
  });

  it("recencyBias is true on recency-style temporal queries", () => {
    const recencyQueries = [
      "What did I do yesterday?",
      "What was my most recent purchase?",
      "What happened last week?",
      "Three days ago I started a project",
      "Have I bought anything recently?",
    ];
    for (const q of recencyQueries) {
      const r = classifyIntent(q);
      expect(r.intent, `query: ${q}`).toBe("temporal");
      expect(r.recencyBias, `query: ${q}`).toBe(true);
    }
  });

  it("recencyBias is false on ordering-style temporal queries", () => {
    const orderingQueries = [
      "Which gift did I buy first, the necklace or the photo album?",
      "Which item arrived earliest?",
      "Who graduated first, Emma or Rachel?",
      "What was the original plan?",
      "Initially, what did I order?",
    ];
    for (const q of orderingQueries) {
      const r = classifyIntent(q);
      expect(r.intent, `query: ${q}`).toBe("temporal");
      expect(r.recencyBias, `query: ${q}`).toBe(false);
    }
  });

  it("assistantReferenceBias fires when query refers to a past assistant statement", () => {
    const queries = [
      "What did you tell me about CITGO Lake Charles Refinery?",
      "You suggested a vegan eatery in NYC — what was the name?",
      "How long did you say I should leave the tomato juice on?",
      "Did you recommend any waterproof cameras?",
      "Can you remind me what your advice was?",
    ];
    for (const q of queries) {
      const r = classifyIntent(q);
      expect(r.assistantReferenceBias, `query: ${q}`).toBe(true);
    }
  });

  it("assistantReferenceBias is undefined / false when query does not reference assistant", () => {
    const queries = [
      "What is my favourite food?",
      "How many weddings have I attended this year?",
      "When did I submit my paper?",
    ];
    for (const q of queries) {
      const r = classifyIntent(q);
      expect(r.assistantReferenceBias, `query: ${q}`).toBe(false);
    }
  });

  it("assistantReferenceBias works alongside other intents (orthogonal)", () => {
    const r = classifyIntent("How many days ago did you tell me about the rafting trip?");
    expect(r.intent).toBe("temporal");
    expect(r.assistantReferenceBias).toBe(true);
  });
});

describe("classifyIntent aggregate-prefix multipliers", () => {
  it("factoid intent boosts aggregate-* but user-fact- still wins", () => {
    const r = classifyIntent("How many emails do I get?");
    expect(r.intent).toBe("factoid");
    expect(r.pathMultipliers?.aggregates).toBeGreaterThan(1);
    expect(r.pathMultipliers?.facts).toBeGreaterThan(r.pathMultipliers?.aggregates ?? 0);
  });

  it("temporal intent boosts aggregate-* but milestone- still wins", () => {
    const r = classifyIntent("How many weddings did I attend last year?");
    expect(r.intent).toBe("temporal");
    expect(r.pathMultipliers?.aggregates).toBeGreaterThan(1);
    expect(r.pathMultipliers?.events).toBeGreaterThan(r.pathMultipliers?.aggregates ?? 0);
  });

  it("preference intent: aggregate- weakly boosted, user-preference- wins", () => {
    const r = classifyIntent("What is my favourite food?");
    expect(r.intent).toBe("preference");
    expect(r.pathMultipliers?.preferences).toBeGreaterThan(r.pathMultipliers?.aggregates ?? 0);
  });
});

describe("applyTypeMultiplier", () => {
  const multipliers = {
    events: 2.35,
    preferences: 0.7,
    context: 0.5,
  } as const;

  it("boosts a matching type", () => {
    expect(applyTypeMultiplier(1, "events", multipliers)).toBeCloseTo(2.35);
  });

  it("penalises a matching type below 1", () => {
    expect(applyTypeMultiplier(2, "preferences", multipliers)).toBeCloseTo(1.4);
  });

  it("returns score unchanged when type isn't in the table", () => {
    expect(applyTypeMultiplier(1.7, "episodic", multipliers)).toBe(1.7);
    expect(applyTypeMultiplier(1.7, "facts", multipliers)).toBe(1.7);
  });
});
