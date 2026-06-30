/**
 * Temporal post-processing for extracted facts (M5.b1).
 *
 * Ports `apps/jeff/internal/knowledge/eval/lme/ingest_replay.go`'s
 * `postProcessSessionFacts` + `autoFactTags` + `buildDateTokens`. The
 * goal: every fact carries enough temporal + entity context inside its
 * own body that BM25 retrieval can match temporal queries ("on
 * Wednesday", "in March", "2024-03-25") and entity queries ("$185",
 * "Stanford") even when the fact's prose doesn't repeat them.
 *
 * Per Alex's measured deltas, this combined with M5.f temporal query
 * expansion lifts temporal-reasoning by ~10-15pp on LongMemEval.
 */

import type { Fact } from "./cache.js";

const AUTO_TAG_DATE_RE = /\b\d{4}[-/]\d{2}[-/]\d{2}\b/g;
const AUTO_TAG_WEEKDAY_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
const AUTO_TAG_QUANTITY_RE = /\b\d{1,6}(?:\.\d+)?\b/g;
const AUTO_TAG_PROPER_NOUN_RE = /\b[A-Z][a-zA-Z]+\b/g;
const AUTO_TAG_MONEY_RE = /[$£€]\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g;
const AUTO_TAG_UNIT_QUANTITY_RE =
  /\b(\d{1,6}(?:\.\d+)?)\s+(minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|months?|years?|km|kilometres?|miles?|metres?|meters?|kg|kilograms?|pounds?|lbs?|grams?|percent|%)\b/gi;

const AUTO_TAG_STOP_NOUN = new Set([
  "the",
  "this",
  "that",
  "these",
  "those",
  "when",
  "where",
  "what",
  "who",
  "why",
  "how",
  "observed",
  "date",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
  "user",
  "assistant",
]);

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Extract a small set of BM25-friendly tags from a fact body: ISO dates,
 * weekday + month names paired with detected dates, currency amounts,
 * unit quantities, bare numbers, and proper nouns. Heuristic is loose by
 * design — BM25 tolerates noise; missing matches hurt more than extras.
 */
export function autoFactTags(content: string): string[] {
  if (!content) return [];

  const body = content.length > 4096 ? content.slice(0, 4096) : content;
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const t = raw.trim();
    if (t === "" || seen.has(t)) return;
    seen.add(t);
  };

  // ISO dates + their weekday/month projections.
  for (const m of body.matchAll(AUTO_TAG_DATE_RE)) {
    if (m[0] !== undefined) {
      add(m[0]);
      const iso = m[0].replaceAll("/", "-");
      const d = new Date(`${iso}T00:00:00Z`);
      if (!Number.isNaN(d.getTime())) {
        const wd = WEEKDAY_NAMES[d.getUTCDay()];
        const mo = MONTH_NAMES[d.getUTCMonth()];
        if (wd) add(wd);
        if (mo) add(mo);
      }
    }
  }

  // Standalone weekday mentions.
  for (const m of body.matchAll(AUTO_TAG_WEEKDAY_RE)) {
    if (m[0] !== undefined) {
      const low = m[0].toLowerCase();
      add(low.charAt(0).toUpperCase() + low.slice(1));
    }
  }

  // Currency amounts.
  for (const m of body.matchAll(AUTO_TAG_MONEY_RE)) {
    if (m[0] !== undefined) add(m[0]);
  }

  // Unit quantities ("45 minutes", "10 km").
  for (const m of body.matchAll(AUTO_TAG_UNIT_QUANTITY_RE)) {
    if (m[1] !== undefined && m[2] !== undefined) {
      add(`${m[1].trim()} ${m[2].trim()}`);
    }
  }

  // Bare numbers (for "watched 4 movies", "spent £10k" style queries).
  for (const m of body.matchAll(AUTO_TAG_QUANTITY_RE)) {
    if (m[0] !== undefined) add(m[0]);
  }

  // Proper nouns (names, places, products). Skip common sentence-starters.
  for (const m of body.matchAll(AUTO_TAG_PROPER_NOUN_RE)) {
    if (m[0] === undefined || m[0].length < 3) continue;
    if (AUTO_TAG_STOP_NOUN.has(m[0].toLowerCase())) continue;
    add(m[0]);
  }

  return [...seen];
}

/**
 * Build a bracketed prefix line carrying ISO date + weekday + month +
 * year so a temporal-query like "on Wednesday" or "in March 2024" hits
 * the fact via plain BM25 even if the prose doesn't say those words.
 *
 * Accepts ISO-8601 date or full RFC-3339 timestamp; returns the empty
 * string when the input doesn't parse.
 */
export function buildDateTokens(isoOrRfc3339: string | undefined): string {
  if (!isoOrRfc3339) return "";
  const trimmed = isoOrRfc3339.trim();
  if (trimmed === "") return "";
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return "";
  const iso = d.toISOString().slice(0, 10);
  const wd = WEEKDAY_NAMES[d.getUTCDay()] ?? "";
  const mo = MONTH_NAMES[d.getUTCMonth()] ?? "";
  const year = String(d.getUTCFullYear());
  return `[Date: ${iso} ${wd} ${mo} ${year}]\n\n`;
}

/**
 * Wrap a fact's content with a temporal prefix derived from its session
 * date and append an `[Observed on …]` marker so retrieval-time
 * formatters can still surface the human-readable original. Tags
 * derived from the post-prefix content are merged into the fact's
 * `entities` field since our retrieval matches against entities at
 * query expansion time.
 */
export function enrichFactWithTemporal(fact: Fact, sessionDate: string | undefined): Fact {
  const dateTokens = buildDateTokens(sessionDate);
  const observed = sessionDate ? `[Observed on ${sessionDate.slice(0, 10)}]` : "";
  const enriched =
    dateTokens === "" && observed === ""
      ? fact.content
      : `${dateTokens}${observed === "" ? "" : `${observed}\n\n`}${fact.content}`;

  const tags = autoFactTags(enriched);
  const existing = new Set((fact.entities ?? []).map((e) => e.trim()).filter((e) => e !== ""));
  for (const t of tags) existing.add(t);
  const merged = [...existing];

  return {
    ...fact,
    content: enriched,
    ...(merged.length > 0 ? { entities: merged } : {}),
  };
}
