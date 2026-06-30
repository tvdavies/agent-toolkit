/**
 * Literal-detail density scoring. Counts dates, monetary amounts, and
 * numbers in a chunk's content; produces a 0–1 score we use to nudge
 * verbatim chunks (which preserve raw turns) above extracted chunks
 * (which often paraphrase away the discriminating detail).
 *
 * Why: M2.v failure diagnostic showed that extracted chunks at typed
 * paths (`milestone-`, `user-fact-`) are systematically demoted by
 * path multipliers, even when their extracted form has lost the date
 * or amount that the question requires. Verbatim chunks at `episodic/*`
 * usually have those details verbatim. A small density-based boost
 * lets information-rich verbatim survive the multiplier penalty.
 *
 * Designed to be additive, not dominant — at boost = 0.15, a chunk
 * scoring 5 details gets ~7.5% boost, enough to flip ranking on
 * borderline cases without overriding semantic relevance.
 */

const DATE_PATTERNS = [
  /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g,
  /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:[a-z]{0,8})?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:[a-z]{0,8})?\b/gi,
];

const MONEY_PATTERN =
  /(?:[$£€¥]\s?\d[\d,]*(?:\.\d+)?(?:k|m|bn)?|\b\d[\d,]*(?:\.\d+)?\s+(?:dollars?|pounds?|euros?|usd|gbp|eur)\b)/gi;

// Plain numbers ≥ 2 (skip "0"/"1" alone — too noisy).
const NUMBER_PATTERN = /\b\d{2,}(?:\.\d+)?\b|\b[2-9]\b/g;

/**
 * Returns the absolute count of date/money/number occurrences in the
 * content. Used directly for the boost factor (density score is
 * roughly proportional to count).
 */
export function countLiteralDetails(content: string): number {
  let count = 0;
  for (const pat of DATE_PATTERNS) count += (content.match(pat) ?? []).length;
  count += (content.match(MONEY_PATTERN) ?? []).length;
  count += (content.match(NUMBER_PATTERN) ?? []).length;
  return count;
}

/**
 * Apply a density-based multiplier to `score`. Returns
 * `score * (1 + boost * count)` capped at `score * (1 + boost * cap)`.
 *
 * Default boost = 0.15 means each detail adds 15% to the score, capped
 * at 5 details (so a fact with 5+ details gets +75% — significant but
 * not overwhelming).
 */
export function applyDensityBoost(score: number, content: string, boost = 0.15, cap = 5): number {
  const count = Math.min(countLiteralDetails(content), cap);
  return score * (1 + boost * count);
}
