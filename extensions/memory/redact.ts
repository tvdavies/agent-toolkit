/**
 * Redaction — strip secrets from text BEFORE it reaches the memory engine.
 *
 * The brain is git-tracked and the ingestion scope is "all sessions", so session
 * transcripts can carry tokens, keys, and private material. @jeffs-brain/memory does
 * NOT scrub anything; this pass is ours and runs on every slice fed to extract().
 *
 * Conservative by design: it favours over-redaction (a memory missing a token is
 * fine; a memory containing one is not). Pure + tested.
 */

const REDACTORS: Array<[RegExp, string]> = [
	// PEM private keys (multi-line).
	[/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED-PRIVATE-KEY]"],
	// Prefixed provider tokens (charclasses include _ and - — real keys use them, e.g.
	// sk-ant-api03-…, sk-proj-…): OpenAI/Anthropic/Stripe sk-/rk-/pk-, Slack xox[baprs]-,
	// GitHub gh[poasu]_/github_pat_, AWS AKIA.
	[/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED-TOKEN]"],
	[/\bxox[baprs]-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED-TOKEN]"],
	[/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED-TOKEN]"],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED-TOKEN]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED-AWS-KEY]"],
	// JWTs (three base64url segments).
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED-JWT]"],
	// Authorization: Bearer <token>.
	[/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [REDACTED]"],
	// key=value / key: value assignments for sensitive keys.
	[/\b(API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|SECRET(?:[_-]?KEY)?|CLIENT[_-]?SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN)(\s*[=:]\s*)("?)[^\s"']{6,}\3/gi, "$1$2[REDACTED]"],
];

/** Redact secrets from a single string. */
export function redact(text: string): string {
	if (!text) return text;
	return REDACTORS.reduce((acc, [re, rep]) => acc.replace(re, rep), text);
}

export type RoleMessage = { role: string; content?: string; [k: string]: unknown };

/** Redact the string content of every message (other fields untouched). */
export function redactMessages<T extends RoleMessage>(messages: readonly T[]): T[] {
	return messages.map((m) => (typeof m.content === "string" ? { ...m, content: redact(m.content) } : m));
}
