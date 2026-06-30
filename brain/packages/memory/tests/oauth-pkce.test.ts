import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePkceVerifier, generateState, pkceChallenge } from "../src/auth/oauth/pkce.ts";

describe("PKCE helpers", () => {
  it("verifier is base64url-safe and ≥43 chars (32-byte input)", () => {
    const verifier = generatePkceVerifier(32);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("two verifiers differ (with overwhelming probability)", () => {
    const a = generatePkceVerifier();
    const b = generatePkceVerifier();
    expect(a).not.toBe(b);
  });

  it("challenge is sha256(verifier) base64url-encoded", () => {
    const verifier = "test-verifier-fixed-string";
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(pkceChallenge(verifier)).toBe(expected);
  });

  it("state is 32 hex chars (16 bytes)", () => {
    const state = generateState(16);
    expect(state).toMatch(/^[0-9a-f]{32}$/);
  });
});
