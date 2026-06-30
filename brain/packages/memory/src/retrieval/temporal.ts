/**
 * Time-decay scoring for temporal-intent queries. A query carrying an
 * anchor date (the question's `question_date` in LongMemEval terms) is
 * implicitly probing memories close to that date — "what did I order
 * yesterday", "first bike service in March". Multiplying chunk scores
 * by an exponential decay over date-distance lets retrieval surface
 * date-proximate chunks ahead of equally-relevant but date-distant
 * ones.
 *
 * Only applied for temporal-intent queries (per `classifyIntent`); on
 * everything else the multiplier is 1 and behaviour is unchanged. This
 * matches Jeff's "augmented reader" pattern: temporal probes get
 * temporal scoring, factoid probes don't.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Default decay half-life. With τ = 30 days, a chunk 30 days from the
 * anchor gets ×0.37; 60 days gets ×0.14; 7 days gets ×0.79. LongMemEval
 * haystacks span 1–2 weeks of conversation per question, so 30 days
 * gives gentle preference to recency without crushing older chunks.
 */
export const DEFAULT_DECAY_DAYS = 30;

/**
 * Parse the LongMemEval date format `YYYY/MM/DD (Day) HH:MM` to ISO.
 * Strips the parenthetical day-of-week marker so `Date` accepts it.
 * Falls back to `undefined` on unparseable input.
 */
export function parseAnchorDate(s: string): Date | undefined {
  const cleaned = s.replace(/\s*\([A-Za-z]+\)\s*/, " ").trim();
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Apply exp(-|days| / decayDays) to `score` based on the absolute
 * difference between a chunk's `recordedAt` and the query's
 * `anchorDate`. When either date is missing or unparseable, returns
 * `score` unchanged.
 */
export function applyTimeDecay(
  score: number,
  chunkRecordedAt: string | undefined,
  anchorDate: Date,
  decayDays: number = DEFAULT_DECAY_DAYS,
): number {
  if (chunkRecordedAt === undefined) return score;
  const chunkDate = parseAnchorDate(chunkRecordedAt);
  if (chunkDate === undefined) return score;
  const days = Math.abs(chunkDate.getTime() - anchorDate.getTime()) / MS_PER_DAY;
  return score * Math.exp(-days / decayDays);
}

/**
 * Render a chunk's content with its `recordedAt` date prepended in
 * `[YYYY-MM-DD]` form when the metadata has a parseable date. The
 * extractor often paraphrases away the date that the original turn
 * contained ("the day of the conversation", or no date at all),
 * leaving the actor unable to answer "how many days ago" / "how many
 * days passed between" questions even when the chunk semantically
 * matches. Surfacing the date programmatically from metadata closes
 * that gap without re-running extraction.
 */
export function renderChunkContent(
  content: string,
  metadata: Record<string, unknown> | undefined,
): string {
  const recordedAt = metadata?.recordedAt;
  if (typeof recordedAt !== "string") return content;
  const d = parseAnchorDate(recordedAt);
  if (d === undefined) return content;
  const isoDate = d.toISOString().slice(0, 10);
  return `[${isoDate}] ${content}`;
}
