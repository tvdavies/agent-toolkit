import { describe, expect, it } from "bun:test";
import { backoffDelay } from "./backoff";

describe("backoffDelay", () => {
	it("grows exponentially from the base", () => {
		expect(backoffDelay(1)).toBe(500);
		expect(backoffDelay(2)).toBe(1000);
		expect(backoffDelay(3)).toBe(2000);
		expect(backoffDelay(4)).toBe(4000);
	});

	it("caps at maxMs", () => {
		expect(backoffDelay(20)).toBe(30_000);
	});

	it("honours custom options", () => {
		expect(backoffDelay(1, { baseMs: 100 })).toBe(100);
		expect(backoffDelay(3, { baseMs: 100, factor: 3 })).toBe(900);
		expect(backoffDelay(10, { baseMs: 100, maxMs: 250 })).toBe(250);
	});

	it("treats attempts below 1 as the first attempt", () => {
		expect(backoffDelay(0)).toBe(500);
		expect(backoffDelay(-5)).toBe(500);
	});
});
