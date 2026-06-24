import { describe, expect, it } from "bun:test";
import { formatRecall, rankHits, type RecallHit } from "./recall";

const NOW = Date.parse("2026-06-24T12:00:00Z");

function hit(partial: Partial<RecallHit> & { conceptId: string }): RecallHit {
	return { matchCount: 1, ...partial };
}

describe("rankHits", () => {
	it("orders by match count when nothing else differs", () => {
		const ranked = rankHits(
			[
				hit({ conceptId: "a", matchCount: 1 }),
				hit({ conceptId: "b", matchCount: 5 }),
				hit({ conceptId: "c", matchCount: 3 }),
			],
			{ now: NOW },
		);
		expect(ranked.map((h) => h.conceptId)).toEqual(["b", "c", "a"]);
	});

	it("applies per-type weights", () => {
		const ranked = rankHits(
			[
				hit({ conceptId: "note", type: "Note", matchCount: 3 }),
				hit({ conceptId: "decision", type: "Decision", matchCount: 1 }),
			],
			{ now: NOW, typeWeights: { Decision: 5 } },
		);
		expect(ranked[0]?.conceptId).toBe("decision");
	});

	it("boosts recent memories over equally-matched stale ones", () => {
		const ranked = rankHits(
			[
				hit({ conceptId: "old", matchCount: 2, timestamp: "2024-01-01T00:00:00Z" }),
				hit({ conceptId: "new", matchCount: 2, timestamp: "2026-06-20T00:00:00Z" }),
			],
			{ now: NOW },
		);
		expect(ranked[0]?.conceptId).toBe("new");
	});

	it("respects the limit", () => {
		const many = Array.from({ length: 10 }, (_, i) =>
			hit({ conceptId: `c${i}`, matchCount: i }),
		);
		expect(rankHits(many, { now: NOW, limit: 3 })).toHaveLength(3);
	});

	it("is a pure function (does not mutate input order)", () => {
		const input = [
			hit({ conceptId: "a", matchCount: 1 }),
			hit({ conceptId: "b", matchCount: 9 }),
		];
		rankHits(input, { now: NOW });
		expect(input.map((h) => h.conceptId)).toEqual(["a", "b"]);
	});
});

describe("formatRecall", () => {
	it("returns an empty string when there are no hits", () => {
		expect(formatRecall([])).toBe("");
	});

	it("renders a block with type, title, id, and snippet", () => {
		const block = formatRecall([
			hit({
				conceptId: "people/tom",
				type: "Person",
				title: "Tom",
				description: "The user.",
				snippet: "Prefers GPT/Gemini over Claude for subagents.",
			}),
		]);
		expect(block).toContain("<brain-recall>");
		expect(block).toContain("[Person] Tom");
		expect(block).toContain("(id: people/tom)");
		expect(block).toContain("> Prefers GPT/Gemini");
		expect(block).toContain("</brain-recall>");
	});

	it("truncates an over-long snippet", () => {
		const block = formatRecall([
			hit({ conceptId: "x", snippet: "y".repeat(500) }),
		]);
		expect(block).toContain("…");
	});
});
