import type { Storage } from "../storage/sqlite.js";
import type { SearchHit } from "../storage/types.js";

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "what",
  "who",
  "when",
  "where",
  "why",
  "how",
  "did",
  "do",
  "does",
  "you",
  "your",
  "i",
  "me",
  "my",
  "we",
  "our",
  "for",
  "from",
  "about",
  "with",
  "into",
  "than",
  "then",
  "this",
  "that",
  "these",
  "those",
  "have",
  "has",
  "had",
  "can",
  "could",
  "would",
  "should",
  "many",
  "much",
  "all",
  "list",
  "total",
  "in",
  "on",
  "at",
  "of",
  "to",
]);

const TRIGRAM_THRESHOLD = 0.3;

export type Bm25RetryAttempt = {
  rung: "original" | "sanitized" | "strongest-term" | "slug-trigram";
  query: string;
  hits: number;
};

export type Bm25RetryResult = {
  hits: SearchHit[];
  attempts: Bm25RetryAttempt[];
};

/**
 * Jeff-style lightweight retry ladder for lexical recall. The storage
 * BM25 query already sanitises punctuation internally, but explicit
 * retry rungs give us observability and a strongest-term / fuzzy-slug
 * fallback when the original query has no lexical overlap with bodies.
 */
export function searchBM25WithRetry(
  storage: Storage,
  query: string,
  limit: number,
): Bm25RetryResult {
  const attempts: Bm25RetryAttempt[] = [];

  const original = storage.searchBM25(query, limit);
  attempts.push({ rung: "original", query, hits: original.length });
  if (original.length > 0) return { hits: original, attempts };

  const sanitized = sanitiseQuery(query);
  if (sanitized !== "" && sanitized !== query) {
    const hits = storage.searchBM25(sanitized, limit);
    attempts.push({ rung: "sanitized", query: sanitized, hits: hits.length });
    if (hits.length > 0) return { hits, attempts };
  }

  const strongest = strongestTerm(query);
  if (strongest !== undefined && strongest !== sanitized && strongest !== query) {
    const hits = storage.searchBM25(strongest, limit);
    attempts.push({ rung: "strongest-term", query: strongest, hits: hits.length });
    if (hits.length > 0) return { hits, attempts };
  }

  const fuzzy = searchSlugTrigram(storage, query, limit);
  attempts.push({ rung: "slug-trigram", query: queryTokens(query).join(" "), hits: fuzzy.length });
  return { hits: fuzzy, attempts };
}

export function sanitiseQuery(query: string): string {
  return query
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function strongestTerm(query: string): string | undefined {
  let best: string | undefined;
  for (const tok of queryTokens(query)) {
    if (best === undefined || tok.length > best.length) best = tok;
  }
  return best;
}

export function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of sanitiseQuery(query).toLowerCase().split(/\s+/)) {
    if (tok.length < 3) continue;
    if (STOP_WORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function searchSlugTrigram(storage: Storage, query: string, limit: number): SearchHit[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0 || limit <= 0) return [];
  const tokenGrams = tokens.map((t) => computeTrigrams(t));
  const scored: SearchHit[] = [];
  for (const chunk of storage.listLiveChunks()) {
    const slugWords = slugTextFor(chunk.path)
      .split(/\s+/)
      .filter((w) => w !== "");
    const slugWordGrams = slugWords.map(computeTrigrams);
    let best = 0;
    for (const grams of tokenGrams) {
      for (const slugGrams of slugWordGrams) best = Math.max(best, jaccard(grams, slugGrams));
    }
    if (best >= TRIGRAM_THRESHOLD) scored.push({ chunk, score: best });
  }
  scored.sort((a, b) => b.score - a.score || b.chunk.ordinal - a.chunk.ordinal);
  return scored.slice(0, limit);
}

function slugTextFor(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base
    .replace(/\.md$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim();
}

function computeTrigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const word of text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)) {
    if (word === "") continue;
    const padded = `$${word}$`;
    for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const g of a) if (b.has(g)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
