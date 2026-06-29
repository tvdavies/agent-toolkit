/**
 * Search adapter — the recall bridge @jeffs-brain/memory expects but does not ship.
 *
 * `recall` calls `searchIndex.search(query, embedding, { k, scope, actorId })` and
 * reads the matched notes back from the store itself; the index only returns
 * `{ path, score }`. The library's own SQLite index needs a native binding
 * (better-sqlite3) that does not load under pi's node runtime, and its no-index
 * fallback scores by counting the WHOLE query as one substring (useless for
 * natural-language recall). So we provide a small term-based BM25-lite index over
 * the store's markdown — no SQLite, works under node and bun.
 *
 * Pure but for the injected store, so the scoring is unit-tested directly.
 */

import { scopePrefix, type Scope, type Store } from "@jeffs-brain/memory";

export type SearchHit = { path: string; score: number };

const STOPWORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "do", "does", "did", "how", "what", "when",
	"where", "why", "who", "to", "of", "in", "on", "for", "and", "or", "my", "me", "you", "your", "it",
	"this", "that", "with", "can", "i", "we", "us", "our", "as", "at", "by", "from", "into", "about",
]);

/** Query → distinct, lowercased, meaningful terms. */
export function queryTerms(query: string): string[] {
	const seen = new Set<string>();
	for (const raw of query.toLowerCase().split(/[^a-z0-9_.-]+/)) {
		const t = raw.replace(/^[.-]+|[.-]+$/g, "");
		if (t.length >= 2 && !STOPWORDS.has(t)) seen.add(t);
	}
	return [...seen];
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let n = 0;
	let i = haystack.indexOf(needle);
	while (i !== -1) {
		n += 1;
		i = haystack.indexOf(needle, i + needle.length);
	}
	return n;
}

/** Occurrences of a term with light plural/singular folding ("tests" ↔ "test"). */
function termFrequency(body: string, term: string): number {
	let n = countOccurrences(body, term);
	if (term.length > 3 && term.endsWith("s")) n += countOccurrences(body, term.slice(0, -1));
	else n += countOccurrences(body, `${term}s`);
	return n;
}
function nameMatches(name: string, term: string): boolean {
	if (name.includes(term)) return true;
	if (term.length > 3 && term.endsWith("s")) return name.includes(term.slice(0, -1));
	return name.includes(`${term}s`);
}

/**
 * Score a note against the query terms. Rewards term frequency, gives a strong
 * coverage bonus for matching MORE distinct terms (so a note touching the whole
 * query beats one that spams a single term), and a filename-match bonus.
 */
export function scoreNote(content: string, filename: string, terms: readonly string[]): number {
	if (terms.length === 0) return 0;
	const body = content.toLowerCase();
	const name = filename.toLowerCase();
	let score = 0;
	let matched = 0;
	for (const t of terms) {
		const occ = termFrequency(body, t);
		const inName = nameMatches(name, t);
		if (occ > 0 || inName) matched += 1;
		if (occ > 0) score += Math.min(occ, 5); // cap per-term frequency so one term can't dominate
		if (inName) score += 2; // filename match is a strong signal
	}
	if (matched === 0) return 0;
	// Coverage dominates: a note touching MORE distinct query terms outranks one that
	// merely repeats a single term (whose frequency is capped above).
	score += matched * 5;
	return score;
}

const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** A `SearchIndex` over the store's markdown notes, for @jeffs-brain/memory recall. */
export function createBm25SearchIndex(store: Store) {
	return {
		async search(
			query: string,
			_embedding: readonly number[] | undefined,
			opts: { readonly k: number; readonly scope?: Scope; readonly actorId?: string },
		): Promise<readonly SearchHit[]> {
			const terms = queryTerms(query);
			if (terms.length === 0) return [];
			const prefix = scopePrefix(opts.scope ?? "global", opts.actorId ?? "");
			let entries: ReadonlyArray<{ path: string; isDir: boolean }>;
			try {
				entries = (await store.list(prefix, { recursive: true })) as ReadonlyArray<{ path: string; isDir: boolean }>;
			} catch {
				return []; // scope dir absent (no memories yet) — not an error
			}
			const hits: SearchHit[] = [];
			for (const e of entries) {
				if (e.isDir) continue;
				const name = lastSegment(String(e.path));
				if (!name.endsWith(".md") || name === "MEMORY.md") continue;
				let content: string;
				try {
					content = (await store.read(e.path as never)).toString("utf8");
				} catch {
					continue;
				}
				const score = scoreNote(content, name, terms);
				if (score > 0) hits.push({ path: e.path, score });
			}
			return hits.sort((a, b) => b.score - a.score).slice(0, opts.k);
		},
	};
}
