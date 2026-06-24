import { describe, expect, it } from "bun:test";
import { applyCumulativeCost, INITIAL_SPEND_STATE, type SpendConfig } from "./spend";

const config: SpendConfig = { dailyCapUsd: 10 };
const T = 1_000_000;

describe("applyCumulativeCost", () => {
	it("baselines on first observation without counting prior spend", () => {
		const r = applyCumulativeCost(INITIAL_SPEND_STATE, 5, config, T);
		expect(r.state.spentTodayUsd).toBe(0);
		expect(r.state.lastCumulativeUsd).toBe(5);
		expect(r.overCap).toBe(false);
	});

	it("accumulates deltas and crosses the cap once", () => {
		let s = applyCumulativeCost(INITIAL_SPEND_STATE, 5, config, T).state;
		s = applyCumulativeCost(s, 8, config, T + 1000).state; // +3 = 3
		const mid = applyCumulativeCost(s, 12, config, T + 2000); // +4 = 7
		expect(mid.overCap).toBe(false);
		s = mid.state;
		const crossed = applyCumulativeCost(s, 20, config, T + 3000); // +8 = 15
		expect(crossed.overCap).toBe(true);
		expect(crossed.justCrossed).toBe(true);
		const after = applyCumulativeCost(crossed.state, 25, config, T + 4000);
		expect(after.overCap).toBe(true);
		expect(after.justCrossed).toBe(false);
	});

	it("resets at the day boundary", () => {
		const over = applyCumulativeCost(
			{ dayStartMs: T, spentTodayUsd: 15, lastCumulativeUsd: 20 },
			21,
			config,
			T + 86_400_001,
		);
		expect(over.state.spentTodayUsd).toBe(0);
		expect(over.overCap).toBe(false);
	});

	it("treats a cumulative drop (session reset) as a new baseline", () => {
		const r = applyCumulativeCost(
			{ dayStartMs: T, spentTodayUsd: 5, lastCumulativeUsd: 20 },
			3,
			config,
			T + 1000,
		);
		expect(r.state.spentTodayUsd).toBe(5); // no negative delta
		expect(r.state.lastCumulativeUsd).toBe(3);
	});
});
