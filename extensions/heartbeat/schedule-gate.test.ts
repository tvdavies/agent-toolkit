import { describe, expect, it } from "bun:test";
import { parseHoursWindow, resolveMinIntervalMinutes, shouldRunHeartbeat } from "./schedule-gate";

describe("resolveMinIntervalMinutes", () => {
	it("honours an explicit env value (0 disables)", () => {
		expect(resolveMinIntervalMinutes("45", "subscription")).toBe(45);
		expect(resolveMinIntervalMinutes("0", "subscription")).toBe(0);
	});
	it("defaults to hourly on subscription/managed auth, else 30", () => {
		expect(resolveMinIntervalMinutes(undefined, "subscription")).toBe(60);
		expect(resolveMinIntervalMinutes(undefined, "anthropic")).toBe(60); // legacy value
		expect(resolveMinIntervalMinutes(undefined, "other")).toBe(30);
		expect(resolveMinIntervalMinutes(undefined, undefined)).toBe(30);
	});
});

// Local-time constructor + local getters → tz-independent assertions.
const at = (h: number, m = 0, s = 0, ms = 0) => new Date(2026, 5, 24, h, m, s, ms);

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

	it("runs at a tick a hair under the interval (grace tolerance)", () => {
		// A 30-min timer with a 60-min gate lands the 60-min tick a few hundred ms
		// short of the boundary; without grace it would skip and drift to 90 min.
		const state = { lastRunMs: at(8, 0, 0, 500).getTime() }; // stamped 500ms after the 08:00 tick
		expect(shouldRunHeartbeat(state, cfg, at(9, 0, 0, 200)).run).toBe(true);
	});

	it("does not admit a genuinely-early (half-interval) tick", () => {
		// The intermediate 30-min tick on a 60-min gate must still skip.
		const state = { lastRunMs: at(8, 0).getTime() };
		expect(shouldRunHeartbeat(state, cfg, at(8, 30, 0, 200)).run).toBe(false);
	});

	it("keeps a clean cadence when the interval equals the timer period", () => {
		// 30-min gate on a 30-min timer: every tick should run, not every other one.
		const c = { minIntervalMin: 30 };
		const state = { lastRunMs: at(8, 0, 0, 500).getTime() };
		expect(shouldRunHeartbeat(state, c, at(8, 30, 0, 200)).run).toBe(true);
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
