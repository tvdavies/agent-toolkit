/**
 * PKCE (Proof Key for Code Exchange) helpers — RFC 7636.
 *
 * The OAuth authorization-code-with-PKCE flow needs:
 *   1. A high-entropy random `verifier` (43-128 chars, URL-safe).
 *   2. The SHA-256 hash of that verifier, base64url-encoded, sent as
 *      `code_challenge` with `code_challenge_method=S256` on the
 *      authorize request.
 *   3. The original verifier replayed on the token-exchange request
 *      so the auth server can confirm we hold it.
 *
 * Public PKCE clients have no client secret; this protocol prevents
 * an attacker who intercepts the auth code from completing the
 * exchange without the verifier.
 */

import { createHash, randomBytes } from "node:crypto";

/** Generate a 32-byte random verifier (≈43 char base64url string). */
export function generatePkceVerifier(byteLength = 32): string {
  return base64url(randomBytes(byteLength));
}

/** SHA-256 hash of the verifier, base64url-encoded — the `code_challenge`. */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** Generate a 16-byte hex string for the OAuth `state` parameter. */
export function generateState(byteLength = 16): string {
  return randomBytes(byteLength).toString("hex");
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}
