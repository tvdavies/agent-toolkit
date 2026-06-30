/**
 * JWT helpers. We never *verify* signatures (the OpenAI auth server
 * just gave us the token; we trust it via TLS to that endpoint) — we
 * only need the payload to extract `chatgpt_account_id`, which every
 * Codex-routed request requires as a header.
 *
 * Brittleness note: this reads `payload["https://api.openai.com/auth"]`
 * and pulls `chatgpt_account_id` out. Any restructuring of OpenAI's
 * JWT payload kills this — we'll see it as a clear "missing claim"
 * error rather than silent failure.
 */

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("not a JWT (expected 3 dot-separated segments)");
  }
  const segment = parts[1];
  if (!segment) throw new Error("JWT payload segment is empty");
  let json: string;
  try {
    json = Buffer.from(segment, "base64url").toString("utf8");
  } catch (err) {
    throw new Error(`failed to base64url-decode JWT payload: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`JWT payload is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("JWT payload is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

export function extractCodexAccountId(accessToken: string): string {
  const payload = decodeJwtPayload(accessToken);
  const claim = payload[OPENAI_AUTH_CLAIM];
  if (typeof claim !== "object" || claim === null) {
    throw new Error(
      `JWT payload is missing the "${OPENAI_AUTH_CLAIM}" claim. ` +
        "Is this actually a Codex-issued access token?",
    );
  }
  const accountId = (claim as Record<string, unknown>).chatgpt_account_id;
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("JWT auth claim does not contain a non-empty `chatgpt_account_id` string.");
  }
  return accountId;
}
