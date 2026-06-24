import { describe, expect, it } from "bun:test";
import { checkEnvFileSecurity } from "./env-secure";

describe("checkEnvFileSecurity", () => {
	it("accepts a 0600 file owned by the current user", () => {
		expect(checkEnvFileSecurity({ mode: 0o600, uid: 1000 }, 1000)).toEqual({ ok: true });
	});

	it("accepts a read-only 0400 file", () => {
		expect(checkEnvFileSecurity({ mode: 0o400, uid: 1000 }, 1000).ok).toBe(true);
	});

	it("rejects group/world-accessible files", () => {
		const r = checkEnvFileSecurity({ mode: 0o644, uid: 1000 }, 1000);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("644");
	});

	it("rejects a file owned by someone else", () => {
		const r = checkEnvFileSecurity({ mode: 0o600, uid: 0 }, 1000);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("owned");
	});
});
