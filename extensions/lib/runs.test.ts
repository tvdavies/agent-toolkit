import { describe, expect, it } from "bun:test";
import { INITIAL_RUNS_STATE, recordRun } from "./runs";

const config = { maxPerDay: 3 };
const T = 1_000_000;

describe("recordRun", () => {
	it("counts runs and goes over cap once, then stays over", () => {
		let s = recordRun(INITIAL_RUNS_STATE, config, T).state; // 1
		expect(recordRun(s, config, T + 1).overCap).toBe(false); // 2
		s = recordRun(s, config, T + 1).state;
		const third = recordRun(s, config, T + 2); // 3 -> over
		expect(third.overCap).toBe(true);
		expect(third.justCrossed).toBe(true);
		const fourth = recordRun(third.state, config, T + 3);
		expect(fourth.overCap).toBe(true);
		expect(fourth.justCrossed).toBe(false);
	});

	it("resets at the day boundary", () => {
		const over = recordRun({ dayStartMs: T, count: 5 }, config, T + 86_400_001);
		expect(over.state.count).toBe(1);
		expect(over.overCap).toBe(false);
	});
});
