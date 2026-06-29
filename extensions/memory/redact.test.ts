import { describe, expect, it } from "bun:test";
import { redact, redactMessages } from "./redact";

// Assemble token fixtures from parts so no contiguous real-looking secret appears in
// source (which would trip GitHub push-protection); redact() still gets the full string.
const tok = (...parts: string[]) => parts.join("");

describe("redact", () => {
	it("strips provider tokens, JWTs, and PEM keys", () => {
		expect(redact(`token is ${tok("sk-", "ant-abc1234567890XYZ987654321")}`)).not.toContain("ant-abc");
		expect(redact(tok("xox", "b-1234567890-abcdefghijklmno"))).toContain("[REDACTED-TOKEN]");
		expect(redact(tok("ghp", "_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))).toContain("[REDACTED-TOKEN]");
		expect(redact(tok("github", "_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz"))).toContain("[REDACTED-TOKEN]");
		expect(redact(`Authorization: Bearer ${tok("abcdef1234567890", "ghijkl")}`)).toContain("Bearer [REDACTED]");
		const jwt = [tok("ey", "JhbGciOiJIUzI1NiJ9"), tok("ey", "JzdWIiOiIxMjM0NTY3ODkwIn0"), "dozjgNryP4J3jVmNHl0w"].join(".");
		expect(redact(`jwt ${jwt}`)).toContain("[REDACTED-JWT]");
		const pem = `${tok("-----BEGIN RSA ", "PRIVATE KEY-----")}\nMIIBOQIBAAJ\n${tok("-----END RSA ", "PRIVATE KEY-----")}`;
		expect(redact(pem)).toBe("[REDACTED-PRIVATE-KEY]");
		expect(redact(tok("AKIA", "IOSFODNN7EXAMPLE"))).toContain("[REDACTED-AWS-KEY]");
		// real provider keys contain underscores — must still be caught.
		expect(redact(tok("sk-", "ant-SHOULD_BE_REDACTED1234567890"))).toBe("[REDACTED-TOKEN]");
		expect(redact(tok("sk-", "proj-AbC_dEf-GhI_jKl1234567890"))).toBe("[REDACTED-TOKEN]");
	});

	it("redacts key=value / key: value secret assignments but keeps the key", () => {
		expect(redact("API_KEY=supersecretvalue123")).toBe("API_KEY=[REDACTED]");
		expect(redact("password: hunter2hunter2")).toBe("password: [REDACTED]");
		expect(redact('CLIENT_SECRET="abcdef123456"')).toContain("CLIENT_SECRET=");
		expect(redact('CLIENT_SECRET="abcdef123456"')).toContain("[REDACTED]");
	});

	it("leaves ordinary prose untouched", () => {
		const prose = "Always run bun test, never npm. The worker pool is daemon/worker-pool.ts.";
		expect(redact(prose)).toBe(prose);
	});

	it("redacts message content only, preserving role + other fields", () => {
		const msgs = [{ role: "user", content: "key API_KEY=topsecret9999 here", extra: 1 }];
		const out = redactMessages(msgs);
		expect(out[0]?.content).toBe("key API_KEY=[REDACTED] here");
		expect(out[0]?.role).toBe("user");
		expect((out[0] as { extra?: number }).extra).toBe(1);
	});
});
