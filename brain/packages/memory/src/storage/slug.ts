/**
 * Deterministic slug generation for memory files.
 *
 * The brain stores each fact as a markdown file at
 * `<root>/<scope>/<type>/<slug>.md`. Slugs are derived from fact body +
 * recordedAt so a given fact always lands at the same filename. The
 * markdown store handles collisions atomically by appending `-2`,
 * `-3`, etc.
 *
 * Goals:
 *  - **Deterministic** — same input always yields same slug.
 *  - **Human-readable** — a glance at the filename should hint at the
 *    fact's contents. `attended-sarah-mikes-wedding-2024-03-15.md`
 *    beats `user-fact-000007.md`.
 *  - **Bounded length** — 60 chars body + 11 char date suffix max.
 *  - **POSIX-safe** — `[a-z0-9-]` only.
 *
 * Algorithm:
 *  1. Strip M5.b1 temporal frontmatter prefixes (`[Date: …]`, `[Observed on …]`)
 *     so they don't dominate the slug.
 *  2. Strip leading "User " / "Assistant " (the extractor's third-person
 *     prefix is noise for filename purposes).
 *  3. Lowercase; normalise possessives (`'s` → empty, `'t` → t).
 *  4. Replace non-alphanumeric with spaces.
 *  5. Drop a small set of stop words.
 *  6. Collapse whitespace, replace with `-`, trim.
 *  7. Cap at 60 chars at a word boundary.
 *  8. If recordedAt parses to a YYYY-MM-DD date, append `-YYYY-MM-DD`.
 *  9. Fallback: if the result is empty, return `untitled` (+ date suffix).
 *
 * Slug uniqueness is the markdown store's responsibility, not this
 * function's. Same input → same output, always.
 */

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "has",
  "had",
  "have",
  "having",
  "their",
  "they",
  "them",
  "his",
  "her",
  "its",
  "it",
  "as",
  "by",
  "from",
  "up",
  "down",
  "out",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "very",
  "user",
  "assistant",
]);

const MAX_BODY_CHARS = 60;
const DATE_RE = /^(\d{4})[-/](\d{2})[-/](\d{2})/;
// M5.b1 prepends two header forms:
//   `[Date: 2024-03-15 Friday March 2024]` (colon-separated)
//   `[Observed on 2024-03-15]`             (space-separated)
// Strip both shapes so they don't dominate the slug.
const FRONTMATTER_PREFIX_RE = /^\s*\[(?:Date:|Observed on)[^\]]*\]\s*/gm;

export function generateSlug(body: string, recordedAt?: string): string {
  // 1. Strip M5.b1 temporal headers so they don't dominate the slug.
  let text = body.replace(FRONTMATTER_PREFIX_RE, "").trim();

  // 2. Strip third-person prefix.
  text = text.replace(/^(User|Assistant)[\s']+/i, "");

  // 3. Lowercase + handle possessives (must come before non-alnum strip).
  text = text.toLowerCase().replace(/'s\b/g, "").replace(/'t\b/g, "t");

  // 4. Replace anything non-alnum with space. Keep digits and ASCII letters.
  text = text.replace(/[^a-z0-9]+/g, " ");

  // 5. Drop stop words.
  const words = text.split(/\s+/).filter((w) => w.length > 0 && !STOP_WORDS.has(w));

  // 6/7. Greedy join up to MAX_BODY_CHARS at a word boundary.
  let slug = "";
  for (const w of words) {
    const candidate = slug.length === 0 ? w : `${slug}-${w}`;
    if (candidate.length > MAX_BODY_CHARS) break;
    slug = candidate;
  }

  // 8. Append date suffix when available + parseable.
  const dateSuffix = formatDateSuffix(recordedAt);

  if (slug.length === 0) {
    return dateSuffix ? `untitled-${dateSuffix}` : "untitled";
  }
  return dateSuffix ? `${slug}-${dateSuffix}` : slug;
}

function formatDateSuffix(recordedAt: string | undefined): string {
  if (recordedAt === undefined) return "";
  const m = recordedAt.match(DATE_RE);
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
}
