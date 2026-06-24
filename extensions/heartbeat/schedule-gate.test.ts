import { describe, expect, it } from "bun:test";
import { parseHoursWindow, shouldRunHeartbeat } from "./schedule-gate";

// Local-time constructor + local getters → tz-independent assertions.
const at = (h: number, m = 0) => new Date(2026, 5, 24, h, m, 0);

describe("parseHoursWindow", () => {
	it("parses HH:MM-HH:MM", () => {
		expect(parseHoursWindow("07:00-23:00")).toEqual({ startMin: 420, endMin: 1380 });
		expect(parseHoursWindow("7:30 - 9:00")).toEqual({ startMin: 450, endMin: 540 });
	});
	it("rejects malformed specs", () => {
		expect(parseHoursWindow("nope")).toBeUndefined();
		expect(parseHoursWindow("25:00-26:00")).toBeUndefined();
		expect(parseHoursWindow(undefined)).toBeUndefined();
	});
});

describe("shouldRunHeartbeat", () => {
	const cfg = { minIntervalMin: 60 };

	it("runs when enough time has elapsed", () => {
		const state = { lastRunMs: at(8, 0).getTime() };
		expect(shouldRunHeartbeat(state, cfg, at(9, 1)).run).toBe(true);
	});

	it("skips within the minimum interval", () => {
		const state = { lastRunMs: at(8, 0).getTime() };
		const v = shouldRunHeartbeat(state, cfg, at(8, 30));
		expect(v.run).toBe(false);
		expect(v.reason).toBe("min-interval");
	});

	it("skips outside the active-hours window", () => {
		const state = { lastRunMs: 0 };
		const config = { minIntervalMin: 30, activeHours: { startMin: 420, endMin: 1380 } }; // 07:00-23:00
		expect(shouldRunHeartbeat(state, config, at(2, 0)).reason).toBe("quiet-hours"); // 02:00 → silent
		expect(shouldRunHeartbeat(state, config, at(9, 0)).run).toBe(true); // 09:00 → active
	});

	it("handles an overnight active window", () => {
		const config = { minIntervalMin: 30, activeHours: { startMin: 1320, endMin: 360 } }; // 22:00-06:00
		const state = { lastRunMs: 0 };
		expect(shouldRunHeartbeat(state, config, at(23, 0)).run).toBe(true);
		expect(shouldRunHeartbeat(state, config, at(3, 0)).run).toBe(true);
		expect(shouldRunHeartbeat(state, config, at(12, 0)).reason).toBe("quiet-hours");
	});
});
