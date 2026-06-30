/**
 * Authority-based scoring (port of GBrain's authority concept).
 *
 * Manual edits and pinned memories should outweigh extracted /
 * inferred ones during retrieval — the user's explicit intent is
 * higher-signal than what an extractor LLM happened to surface from
 * a transcript. Each chunk carries an `authority` value in its
 * frontmatter; the retriever multiplies the fused score by an
 * authority-specific factor.
 *
 * Default level when frontmatter is silent is `extracted` (×1.0)
 * so legacy chunks stay in their existing rank. The conflict-
 * resolution semantics live in the daemon (a future task): when
 * dedup wants to mark a manually-pinned chunk as `superseded_by`,
 * it skips the action and emits a "conflict" event the user can
 * review.
 */

export const AUTHORITY_LEVELS = [
  "pinned",
  "manual",
  "observed",
  "extracted",
  "imported",
  "inferred",
  "consolidated",
] as const;

export type Authority = (typeof AUTHORITY_LEVELS)[number];

const MULTIPLIERS: Record<Authority, number> = {
  pinned: 3.0,
  manual: 2.0,
  observed: 1.5,
  extracted: 1.0,
  imported: 0.95,
  inferred: 0.8,
  consolidated: 0.7,
};

export const DEFAULT_AUTHORITY: Authority = "extracted";

/** Coerce an unknown frontmatter value to a valid Authority, falling back to default. */
export function coerceAuthority(raw: unknown): Authority {
  if (typeof raw !== "string") return DEFAULT_AUTHORITY;
  return (AUTHORITY_LEVELS as readonly string[]).includes(raw)
    ? (raw as Authority)
    : DEFAULT_AUTHORITY;
}

export function authorityMultiplier(authority: Authority): number {
  return MULTIPLIERS[authority];
}

export type AuthorityBearing = {
  score: number;
  metadata?: Record<string, unknown>;
};

/**
 * Apply the authority multiplier in place to each hit. Returns the
 * effective multiplier per hit so callers can stamp it onto the
 * scoring trace.
 */
export function applyAuthorityBoost<T extends AuthorityBearing>(hits: readonly T[]): number[] {
  const out = new Array<number>(hits.length);
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i] as T;
    const auth = coerceAuthority(hit.metadata?.authority);
    const m = authorityMultiplier(auth);
    hit.score *= m;
    out[i] = m;
  }
  return out;
}
