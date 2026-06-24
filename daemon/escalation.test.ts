import { describe, expect, it } from "bun:test";
import {
	type EscalationBudget,
	evaluateEscalation,
	INITIAL_ESCALATION_STATE,
} from "./escalation";

const budget: EscalationBudget = { maxPerWindow: 2, windowMs: 1000, minGapMs: 100 };

describe("evaluateEscalation", () => {
	it("allows the first escalation and records it", () => {
		const d = evaluateEscalation(INITIAL_ESCALATION_STATE, budget, 1000);
		expect(d.allowed).toBe(true);
		expect(d.state.countInWindow).toBe(1);
		expect(d.state.lastEscalationMs).toBe(1000);
	});

	it("denies within the minimum gap", () => {
		const first = evaluateEscalation(INITIAL_ESCALATION_STATE, budget, 1000).state;
		const d = evaluateEscalation(first, budget, 1050);
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("min-gap");
		expect(d.state.countInWindow).toBe(1); // unchanged
	});

	it("denies once the window budget is exhausted", () => {
		const s1 = evaluateEscalation(INITIAL_ESCALATION_STATE, budget, 1000).state;
		const s2 = evaluateEscalation(s1, budget, 1200).state;
		expect(s2.countInWindow).toBe(2);
		const d = evaluateEscalation(s2, budget, 1400);
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("budget-exhausted");
	});

	it("rolls the window forward, resetting the count", () => {
		const s1 = evaluateEscalation(INITIAL_ESCALATION_STATE, budget, 1000).state;
		const s2 = evaluateEscalation(s1, budget, 1200).state;
		const d = evaluateEscalation(s2, budget, 2300); // > windowMs after windowStart
		expect(d.allowed).toBe(true);
		expect(d.state.countInWindow).toBe(1);
	});
});
