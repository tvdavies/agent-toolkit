/**
 * Brain recall — pure ranking and formatting of search hits.
 *
 * Kept free of fs/ripgrep/Pi dependencies so the scoring logic (the part most
 * likely to regress) is unit-tested directly. {@link store} feeds it raw hits
 * gathered from ripgrep; this module orders them and renders the compact
 * context block injected into the system prompt.
 */

/** A single candidate memory surfaced by a search, before ranking. */
export type RecallHit = {
	conceptId: string;
	type?: string;
	title?: string;
	description?: string;
	tags?: string[];
	/** ISO 8601 last-modified, if known. */
	timestamp?: string;
	/** Total ripgrep matches in the file — a coarse relevance signal. */
	matchCount: number;
	/** First matching line, trimmed — shown as a one-line preview. */
	snippet?: string;
};

export type RankOptions = {
	limit?: number;
	/** Per-type additive score boosts, e.g. { Decision: 2, Person: 1 }. */
	typeWeights?: Record<string, number>;
	/** Current epoch ms; injectable for deterministic tests. */
	now?: number;
};

const DEFAULT_LIMIT = 6;
const SNIPPET_MAX = 160;
const DAY_MS = 86_400_000;

/** Recency boost: strong for the last week, mild for the last month, else none. */
function recencyBoost(timestamp: string | undefined, now: number): number {
	if (!timestamp) return 0;
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) return 0;
	const ageDays = (now - parsed) / DAY_MS;
	if (ageDays <= 7) return 2;
	if (ageDays <= 30) return 1;
	return 0;
}

function scoreOf(hit: RecallHit, opts: Required<RankOptions>): number {
	const typeWeight = hit.type ? (opts.typeWeights[hit.type] ?? 0) : 0;
	return hit.matchCount + typeWeight + recencyBoost(hit.timestamp, opts.now);
}

/**
 * Rank hits by relevance score, descending. Ties break toward the more
 * recently modified concept, then alphabetically by id for stability.
 */
export function rankHits(hits: RecallHit[], options: RankOptions = {}): RecallHit[] {
	const opts: Required<RankOptions> = {
		limit: options.limit ?? DEFAULT_LIMIT,
		typeWeights: options.typeWeights ?? {},
		now: options.now ?? Date.now(),
	};
	return [...hits]
		.map((hit) => ({ hit, score: scoreOf(hit, opts) }))
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			const at = a.hit.timestamp ? Date.parse(a.hit.timestamp) : 0;
			const bt = b.hit.timestamp ? Date.parse(b.hit.timestamp) : 0;
			if (bt !== at) return bt - at;
			return a.hit.conceptId.localeCompare(b.hit.conceptId);
		})
		.slice(0, opts.limit)
		.map((entry) => entry.hit);
}

function truncate(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function headline(hit: RecallHit): string {
	const label = hit.title ?? hit.conceptId;
	const type = hit.type ? `[${hit.type}] ` : "";
	const desc = hit.description ? ` — ${truncate(hit.description, 100)}` : "";
	return `${type}${label}${desc} (id: ${hit.conceptId})`;
}

/**
 * Render ranked hits as a compact recall block for the system prompt. Returns
 * the empty string when there is nothing to inject (so callers add nothing).
 */
export function formatRecall(hits: RecallHit[]): string {
	if (hits.length === 0) return "";
	const lines = ["<brain-recall>", "Relevant memories from your brain:"];
	for (const hit of hits) {
		lines.push(`- ${headline(hit)}`);
		if (hit.snippet) lines.push(`  > ${truncate(hit.snippet, SNIPPET_MAX)}`);
	}
	lines.push(
		"Treat these as potentially stale; verify load-bearing details before relying on them.",
		"</brain-recall>",
	);
	return lines.join("\n");
}
