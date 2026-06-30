/**
 * Redaction — strip secrets from text BEFORE it reaches the memory engine.
 *
 * The brain is a durable, inspectable store and ingestion scope is "all local
 * sessions" (CLI turns, Claude Code / Pi connectors), so any miss is written to
 * disk AND later fed to the extraction model and injected into prompts. This is
 * the only secret defence on the write path, so it deliberately favours
 * OVER-redaction — a memory missing a value is fine; one holding a live
 * credential is not.
 *
 * It runs in the engine's `record()` chokepoint (not as an extension): the
 * extension event pipeline is not wired into the live ingestion path, so a
 * core call is the only placement that reliably covers every source.
 *
 * Two layers:
 *  1. Shape-specific rules for known credential formats (provider tokens, keys, URLs).
 *  2. A generic key=value / "key": "value" rule that catches arbitrary credentials by
 *     a secret-ish key NAME, including PREFIXED env-vars (AWS_SECRET_ACCESS_KEY=…) and
 *     quoted config dumps — the dominant real-world form.
 *
 * Pure + heavily tested against a table of real-world secret formats.
 */

import type { MemoryEvent } from "@ai-assistant/contracts";

const VALUE = `[^\\s"'\`,;)}\\]]`; // a credential value: no whitespace/quote/delimiter

const REDACTORS: Array<[RegExp, string]> = [
  // --- multi-line / structural ---
  // PEM private keys.
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "[REDACTED-PRIVATE-KEY]",
  ],
  // Connection URLs with an inline password: scheme://user:password@host → keep scheme/user/host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi, "$1:[REDACTED]@"],

  // --- provider tokens by prefix (charclasses include _ and -; real keys use them) ---
  // OpenAI / Anthropic (sk-…, sk-proj-…, sk-ant-api03-…) and Stripe (sk_live_, rk_live_, sk_test_).
  [/\b(?:sk|rk|pk)[_-][A-Za-z0-9_-]{16,}\b/g, "[REDACTED-TOKEN]"],
  // Slack xoxb/xoxp/xoxa/xoxr/xoxe/xapp.
  [/\bx(?:ox[baprse]|app)-[A-Za-z0-9-]{10,}\b/g, "[REDACTED-TOKEN]"],
  // GitHub PATs / OAuth.
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED-TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED-TOKEN]"],
  // npm / PyPI.
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, "[REDACTED-TOKEN]"],
  [/\bpypi-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED-TOKEN]"],
  // Google: API key (AIza…), OAuth access token (ya29.…), OAuth client secret (GOCSPX-…).
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED-TOKEN]"],
  [/\bya29\.[0-9A-Za-z._-]{20,}/g, "[REDACTED-TOKEN]"],
  [/\bGOCSPX-[0-9A-Za-z_-]{16,}\b/g, "[REDACTED-TOKEN]"],
  // AWS access key IDs (AKIA/ASIA/AGPA/AIDA/AROA/ANPA/ANVA…) — the secret value is caught
  // by the key=value rule (aws_secret_access_key=…) and the high-entropy fallback.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g, "[REDACTED-AWS-KEY]"],
  // JWTs (three base64url segments).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED-JWT]"],

  // --- generic credential assignments (the catch-all) ---
  // Strong password-like keys (optionally prefixed): redact the value.
  [
    new RegExp(
      `(^|[^A-Za-z0-9_])((?:[A-Za-z0-9]+[_-])*(?:password|passwd|passphrase|pwd|secret|client[_-]?secret|account[_-]?key|shared[_-]?access[_-]?key))(["']?\\s*[=:]\\s*["']?)(${VALUE}{4,})`,
      "gi",
    ),
    "$1$2$3[REDACTED]",
  ],
  // Compound credential names ending in api_key / *_key / *_token / access_key / etc. The
  // leading [^A-Za-z0-9_] (not \\b) is the fix: underscores are word chars, so a prefixed
  // name like AWS_SECRET_ACCESS_KEY has no internal \\b and a \\b-anchored rule leaks it.
  [
    new RegExp(
      `(^|[^A-Za-z0-9_])((?:[A-Za-z0-9]+[_-])+(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key|secret[_-]?key|signing[_-]?key|encryption[_-]?key|key|token|secret))(["']?\\s*[=:]\\s*["']?)(${VALUE}{6,})`,
      "gi",
    ),
    "$1$2$3[REDACTED]",
  ],
  // Bare api_key / apikey assignments (no prefix needed — unambiguous).
  [
    new RegExp(
      `(^|[^A-Za-z0-9_])(api[_-]?key|apikey|access[_-]?token|auth[_-]?token)(["']?\\s*[=:]\\s*["']?)(${VALUE}{6,})`,
      "gi",
    ),
    "$1$2$3[REDACTED]",
  ],

  // --- high-entropy fallback (last resort for opaque session tokens / blobs) ---
  // A long unbroken base64/base64url/hex run with no word boundaries inside is almost
  // never prose; redact it. Conservative length (40+) limits false positives.
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[REDACTED-BLOB]"],
  [/\b[A-Za-z0-9_-]{50,}\b/g, "[REDACTED-BLOB]"],
];

/** Redact secrets from a single string. Idempotent: re-running over redacted text is a no-op. */
export function redact(text: string): string {
  if (!text) return text;
  return REDACTORS.reduce((acc, [re, rep]) => acc.replace(re, rep), text);
}

/** Recursively redact every string inside an arbitrary JSON-ish value (tool args/results). */
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

/**
 * Redact the secret-bearing fields of a {@link MemoryEvent}, returning a new
 * event. This is the single write-path chokepoint — every `kind` that carries
 * free text or tool payloads is scrubbed before the event is persisted,
 * enqueued, or sent to the extraction model.
 */
export function redactEvent(event: MemoryEvent): MemoryEvent {
  switch (event.kind) {
    case "user-turn":
    case "assistant-turn":
      return { ...event, text: redact(event.text) };
    case "ingested-item":
      return { ...event, content: redact(event.content) };
    case "tool-call":
      return { ...event, args: redactDeep(event.args), result: redactDeep(event.result) };
    default:
      return event;
  }
}
