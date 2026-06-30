/**
 * Temporal query expansion (M5.f, Alex Phase B).
 *
 * Ports `apps/jeff/internal/query/temporal.go`. Resolves relative
 * temporal references in a question against an anchor date so BM25 can
 * land hits on facts tagged with absolute dates.
 *
 * Per Alex's measured deltas, this combined with M5.b1 temporal
 * frontmatter lifts temporal-reasoning ~10-15pp on LongMemEval.
 *
 * Examples (anchor = 2023-04-10 Mon):
 *   "two weeks ago"   → "two weeks ago (around 2023/03/27)"
 *   "last Saturday"   → "last Saturday (2023/04/08)"
 *   "what was the first thing I did" → "...first thing I did [Note: look for the earliest dated event]"
 */

const RELATIVE_TIME_RE = /(\d+)\s+(day|days|week|weeks|month|months)\s+ago/gi;
const LAST_WEEKDAY_RE = /last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/gi;

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export interface TemporalExpansion {
  readonly originalQuery: string;
  readonly expandedQuery: string;
  readonly dateHints: readonly string[];
  readonly resolved: boolean;
}

/**
 * Resolve relative temporal references against an anchor date.
 *
 * `anchorDate` accepts the LongMemEval format `"2023/04/10 (Mon) 23:07"`
 * and a few common ISO variants. When parsing fails, the original
 * question is returned unchanged.
 */
export function expandTemporal(
  question: string,
  anchorDate: string | undefined,
): TemporalExpansion {
  const fallback: TemporalExpansion = {
    originalQuery: question,
    expandedQuery: question,
    dateHints: [],
    resolved: false,
  };
  if (!anchorDate) return fallback;
  const anchor = parseAnchor(anchorDate);
  if (anchor === undefined) return fallback;

  const hints: string[] = [];
  let q = question;

  q = q.replaceAll(RELATIVE_TIME_RE, (match, nStr: string, unit: string) => {
    const n = Number.parseInt(nStr, 10);
    if (Number.isNaN(n)) return match;
    const days = unitToDays(unit, n);
    if (days === undefined) return match;
    const resolved = new Date(anchor);
    if (unit.toLowerCase().startsWith("month")) {
      resolved.setUTCMonth(resolved.getUTCMonth() - n);
    } else {
      resolved.setUTCDate(resolved.getUTCDate() - days);
    }
    const dateStr = formatSlash(resolved);
    hints.push(dateStr);
    return `${match} (around ${dateStr})`;
  });

  q = q.replaceAll(LAST_WEEKDAY_RE, (match, weekday: string) => {
    const target = WEEKDAY_INDEX[weekday.toLowerCase()];
    if (target === undefined) return match;
    const d = new Date(anchor);
    for (let i = 1; i <= 7; i++) {
      d.setUTCDate(d.getUTCDate() - 1);
      if (d.getUTCDay() === target) {
        const dateStr = formatSlash(d);
        hints.push(dateStr);
        return `${match} (${dateStr})`;
      }
    }
    return match;
  });

  q = annotateOrdering(q);

  if (hints.length > 0 || q !== question) {
    return {
      originalQuery: question,
      expandedQuery: q,
      dateHints: hints,
      resolved: hints.length > 0,
    };
  }
  return fallback;
}

function unitToDays(unit: string, n: number): number | undefined {
  const u = unit.toLowerCase();
  if (u.startsWith("day")) return n;
  if (u.startsWith("week")) return n * 7;
  if (u.startsWith("month")) return n * 30;
  return undefined;
}

function parseAnchor(s: string): Date | undefined {
  const trimmed = s.trim();
  if (trimmed === "") return undefined;
  // LME format `2023/04/10 (Mon) 23:07` and the dash-equivalent
  // `2023-04-10`. Prefer regex extraction for determinism — JavaScript's
  // `Date` constructor varies by host on slash-separated dates.
  const m = trimmed.match(/(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (m?.[1] && m[2] && m[3]) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:00Z`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

function formatSlash(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function annotateOrdering(q: string): string {
  const lower = q.toLowerCase();
  if (lower.includes("first") || lower.includes("earlier") || lower.includes("before")) {
    return `${q} [Note: look for the earliest dated event]`;
  }
  if (lower.includes("most recent") || lower.includes("latest") || lower.includes("last time")) {
    return `${q} [Note: look for the most recently dated event]`;
  }
  return q;
}
