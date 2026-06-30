/**
 * Degenerate-output detection for LLM extraction results.
 *
 * Borrowed from Mastra's Observer agent (`detectDegenerateRepetition`
 * in their observational-memory package). When an LLM extractor falls
 * into a repetition loop — usually under low-temperature stress or
 * when given malformed input — it can emit thousands of tokens of
 * near-duplicate content. Without a guard, that output gets stored
 * verbatim into our chunks/aggregates and pollutes retrieval forever.
 *
 * The detector samples several windows of the output and checks how
 * many of them are duplicates of each other. If too many windows
 * repeat, the output is flagged degenerate and the caller should
 * treat the call as a failure (skip storage, optionally retry).
 *
 * Cheap pure function — no LLM call, no external dependency. Safe to
 * call on every extractor output.
 */

const DEFAULT_WINDOW_BYTES = 200;
const DEFAULT_MAX_REPEAT_FRACTION = 0.4;
const DEFAULT_MIN_LENGTH_TO_CHECK = 600;

export type DegeneracyReport = {
  degenerate: boolean;
  /** Number of sampled windows. */
  windowCount: number;
  /** Number of windows that match another window verbatim. */
  duplicateCount: number;
  /** duplicateCount / windowCount. */
  repeatFraction: number;
};

/**
 * Sample fixed-byte windows from `s` and report how often they
 * duplicate each other. When `repeatFraction > maxRepeatFraction` the
 * output is judged degenerate.
 *
 * Defaults match Mastra's observer: 200-byte windows, flag at >40%
 * repeat. Inputs shorter than `minLengthToCheck` (default 600 chars)
 * are passed through — the sampling is unreliable on tiny outputs.
 */
export function detectDegenerateRepetition(
  s: string,
  opts: {
    windowBytes?: number;
    maxRepeatFraction?: number;
    minLengthToCheck?: number;
  } = {},
): DegeneracyReport {
  const windowBytes = opts.windowBytes ?? DEFAULT_WINDOW_BYTES;
  const maxRepeatFraction = opts.maxRepeatFraction ?? DEFAULT_MAX_REPEAT_FRACTION;
  const minLengthToCheck = opts.minLengthToCheck ?? DEFAULT_MIN_LENGTH_TO_CHECK;

  if (s.length < minLengthToCheck) {
    return {
      degenerate: false,
      windowCount: 0,
      duplicateCount: 0,
      repeatFraction: 0,
    };
  }

  // Take overlapping windows at stride windowBytes/2 so we don't miss
  // a repeat that straddles a non-overlapping boundary.
  const stride = Math.max(1, Math.floor(windowBytes / 2));
  const windows: string[] = [];
  for (let i = 0; i + windowBytes <= s.length; i += stride) {
    windows.push(s.slice(i, i + windowBytes));
  }

  if (windows.length < 2) {
    return {
      degenerate: false,
      windowCount: windows.length,
      duplicateCount: 0,
      repeatFraction: 0,
    };
  }

  const seen = new Map<string, number>();
  for (const w of windows) seen.set(w, (seen.get(w) ?? 0) + 1);
  let duplicateCount = 0;
  for (const count of seen.values()) {
    if (count > 1) duplicateCount += count;
  }
  const repeatFraction = duplicateCount / windows.length;

  return {
    degenerate: repeatFraction > maxRepeatFraction,
    windowCount: windows.length,
    duplicateCount,
    repeatFraction,
  };
}
