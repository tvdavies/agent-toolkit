/**
 * Open Knowledge Format (OKF) helpers for memory frontmatter.
 *
 * OKF (https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
 * shapes a knowledge document's frontmatter around `type` (required) plus
 * `title`, `description`, `tags` and `timestamp`. The memory engine already
 * carries a richer, provenance-aware field set; the OKF projection adds the
 * presentation fields it lacks (chiefly `title`) and mirrors `tags`/`timestamp`
 * onto the native `topics`/`recordedAt` so files are OKF-conformant while the
 * SQLite index keeps reading the canonical native keys unchanged.
 */

const MAX_TITLE_LEN = 80;
const ROLE_PREFIX = /^(?:user|assistant|system|tool|human|ai)\s*[:>-]\s*/i;
const LEADING_MARKERS = /^[#>\-*+\s]+/;

/**
 * Derive an OKF `title` for a memory. Prefers an explicit source title (e.g. a
 * Slack thread subject); otherwise distils the first meaningful line of the
 * content — stripping role prefixes and markdown markers — and truncates it to
 * a human-scale label at a word boundary.
 */
export function deriveOkfTitle(content: string, sourceTitle?: string): string {
  const explicit = sourceTitle?.trim();
  if (explicit) return explicit;

  const firstLine =
    content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  const cleaned = firstLine.replace(ROLE_PREFIX, "").replace(LEADING_MARKERS, "").trim();
  if (cleaned === "") return "Memory";
  if (cleaned.length <= MAX_TITLE_LEN) return cleaned;

  const truncated = cleaned.slice(0, MAX_TITLE_LEN - 1).replace(/\s+\S*$/, "");
  return `${(truncated || cleaned.slice(0, MAX_TITLE_LEN - 1)).trimEnd()}…`;
}
