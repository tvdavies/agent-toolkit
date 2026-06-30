/**
 * Cheap query-intent classification. Mirrors the spirit of Jeff's
 * intent-reweighting pipeline: a small bank of regexes that detect
 * query shapes where BM25 is the right tool and vector retrieval
 * just adds noise.
 *
 * Drives three retrieval-side knobs:
 *
 *   1. RRF fusion weights (`weights.bm25`, `weights.vector`) — let
 *      callers down-weight or skip the vector leg per query type.
 *   2. Retrieval recall budget (`topK`) — counting / aggregation
 *      questions can request more chunks. Reserved (current
 *      classifier doesn't set; M2.k–m showed unconditional bumps hurt).
 *   3. **Type-based score multipliers (`pathMultipliers`)** — boost
 *      or down-weight chunks by their memory category. The on-disk
 *      directories (`facts/`, `preferences/`, `events/`,
 *      `decisions/`, `context/`, `observations/`, `aggregates/`,
 *      `episodic/`) become the multiplier keys. The field name
 *      stays `pathMultipliers` for historical reasons but the keys
 *      are now memory types, matched against `Chunk.type`.
 *
 * Calibration history:
 *  - M2.c–M2.h: weights only.
 *  - M2.i: strong-signal temporal regex (16/17 dev coverage). 56%.
 *  - M2.k/l/m: K-bumps regressed or washed.
 *  - M2.n/o: actor swap + RAG-Fusion regressed.
 *  - M2.p: path-prefix reweighting (`user-fact-*.md` etc).
 *  - **Markdown-store rip (current): type-keyed reweighting.** Same
 *    multiplier values, just keyed by the directory-aligned `type`
 *    field on each chunk instead of a synthetic filename prefix.
 */

import type { MemoryType } from "../storage/markdown-store.js";

export type FusionWeights = {
  bm25: number;
  vector: number;
};

export type IntentClassification = {
  intent: "temporal" | "factoid" | "preference" | "general";
  weights: FusionWeights;
  /** Optional topK override. */
  topK?: number;
  /**
   * Map of `Chunk.type` → multiplier applied to fused retrieval
   * scores. Types not listed default to 1.0. Multipliers in [0, 1)
   * penalise; >1 boost. Values cribbed from Jeff's published RRF
   * multipliers (2.2× / 2.35× / 0.45×).
   */
  pathMultipliers?: Partial<Record<MemoryType, number>>;
  /**
   * True when the query is asking about *recent* events ("last week",
   * "yesterday", "most recent"). Drives temporal-anchoring decay at
   * retrieval. False for ordering-style temporal queries ("which was
   * first") where decay would hurt — we want older events ranked just
   * as readable as recent ones for those.
   */
  recencyBias?: boolean;
  /**
   * True when the query references a previous assistant statement ("you
   * told me X", "you suggested Y", "what did you recommend"). At
   * retrieve time the score on verbatim chunks whose content begins
   * `assistant: ` is boosted, because globally indexing assistant text
   * dilutes everything else but for these queries the assistant turn
   * is exactly where the answer lives. Borrowed from MemPalace's
   * `is_assistant_reference()` heuristic. Targets the
   * single-session-assistant category.
   */
  assistantReferenceBias?: boolean;
};

const MONTH_RE =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DAY_RE =
  "mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";

const TEMPORAL_RE = new RegExp(
  [
    "\\bwhen\\b",
    "\\bwhat (?:date|time|day|month|year)\\b",
    "\\bon (?:the )?\\d",
    "\\bin \\d{4}\\b",
    `\\b(?:${MONTH_RE})\\b`,
    `\\b(?:${DAY_RE})\\b`,
    "\\b(?:today|yesterday|tonight|tomorrow)\\b",
    "\\bthis (?:morning|afternoon|evening|week|month|year)\\b",
    "\\blast (?:week|month|year|night|time)\\b",
    "\\brecent(?:ly)?\\b",
    "\\b(?:earlier|since|before|after)\\b",
    "\\bago\\b",
    "\\b(?:passed|elapsed)\\s+between\\b",
    "\\b(?:first|second|third|fourth|fifth|earliest|latest|most recent|original(?:ly)?|initial(?:ly)?)\\b",
  ].join("|"),
  "i",
);

/**
 * Assistant-reference markers — queries that recall an assistant
 * statement ("you suggested", "you told me X", "what did you say
 * about Y"). When this fires the retrieval scoring boosts verbatim
 * chunks whose content begins `assistant: `.
 */
const ASSISTANT_REFERENCE_RE = new RegExp(
  [
    "\\byou (?:told|said|mentioned|suggested|recommended|advised|noted|explained|wrote|listed|described|gave|shared|stated|claimed|reminded|warned)\\b",
    "\\bdid you (?:say|tell|mention|suggest|recommend|note|explain|share|list|describe|give|advise)\\b",
    "\\bwhat did you (?:say|tell|recommend|suggest|explain|note|share|describe)\\b",
    "\\b(?:your|the) (?:advice|recommendation|suggestion|response|reply)\\b",
  ].join("|"),
  "i",
);

/**
 * Recency markers — queries asking about *recent* events specifically.
 * Subset of temporal queries; drives time-decay scoring. Excludes
 * ordering markers ("first/earliest/initially") because for those we
 * want older events ranked equally with recent ones.
 */
const RECENCY_RE = new RegExp(
  [
    "\\b(?:today|yesterday|tonight|tomorrow)\\b",
    "\\bthis (?:morning|afternoon|evening|week|month|year)\\b",
    "\\blast (?:week|month|year|night|time)\\b",
    "\\brecent(?:ly)?\\b",
    "\\b(?:latest|most recent|currently)\\b",
    "\\bago\\b",
  ].join("|"),
  "i",
);

const FACTOID_RE =
  /\b(how many|how much|where (?:is|do|did|are|was)|who (?:is|are|was|were)|which (?:day|date|time|month|year|one)|what (?:is|are|was|were) the (?:exact|specific|capital|name|address|amount|number|price|cost))\b/i;

const PREFERENCE_RE =
  /\b(favou?rite|prefer(?:s|red|ence)?|like(?:s|d)? (?:to|the)|love(?:s|d)?|enjoy(?:s|ed)?|dislike(?:s|d)?|hate(?:s|d)?|usually|tend(?:s|ed)? to)\b/i;

/**
 * Per-intent type multiplier tables. Values calibrated from Jeff's
 * published 2.2× / 2.35× / 0.45× scheme. Aggregate multipliers are
 * deliberately modest — the consolidator's summaries can be wrong
 * (under-count, paraphrase away count info) and a dominant boost
 * lets a wrong aggregate displace correct verbatim chunks (observed
 * on M2.v smoke `5c40ec5b`, `a1eacc2a`). At ~1.4× the aggregate
 * contributes as one candidate among many; the actor still sees and
 * can prefer the underlying verbatim/extracted facts when the
 * aggregate is unreliable.
 */
const TEMPORAL_TYPE_MULTIPLIERS: Partial<Record<MemoryType, number>> = {
  aggregates: 1.5,
  events: 2.35,
  observations: 1.3,
  facts: 1.0,
  decisions: 1.5,
  preferences: 0.7,
  context: 0.5,
};

const FACTOID_TYPE_MULTIPLIERS: Partial<Record<MemoryType, number>> = {
  aggregates: 1.5,
  facts: 2.0,
  observations: 1.4,
  events: 1.0,
  preferences: 1.0,
  decisions: 1.0,
  context: 0.8,
};

const PREFERENCE_TYPE_MULTIPLIERS: Partial<Record<MemoryType, number>> = {
  aggregates: 1.4,
  preferences: 2.2,
  observations: 1.7,
  facts: 1.2,
  decisions: 1.0,
  events: 0.6,
  context: 0.7,
};

export function classifyIntent(query: string): IntentClassification {
  // assistantReferenceBias is orthogonal to intent — any query type
  // can also reference an assistant statement.
  const assistantReferenceBias = ASSISTANT_REFERENCE_RE.test(query);
  if (TEMPORAL_RE.test(query)) {
    return {
      intent: "temporal",
      weights: { bm25: 1, vector: 0 },
      pathMultipliers: TEMPORAL_TYPE_MULTIPLIERS,
      recencyBias: RECENCY_RE.test(query),
      assistantReferenceBias,
    };
  }
  if (FACTOID_RE.test(query)) {
    return {
      intent: "factoid",
      weights: { bm25: 1, vector: 0.3 },
      pathMultipliers: FACTOID_TYPE_MULTIPLIERS,
      assistantReferenceBias,
    };
  }
  if (PREFERENCE_RE.test(query)) {
    return {
      intent: "preference",
      weights: { bm25: 0.5, vector: 1 },
      pathMultipliers: PREFERENCE_TYPE_MULTIPLIERS,
      assistantReferenceBias,
    };
  }
  return {
    intent: "general",
    weights: { bm25: 1, vector: 1 },
    assistantReferenceBias,
  };
}

/**
 * Apply type-keyed multipliers to a chunk's score. Pure helper used
 * by `OurMemory.retrieve` post-RRF. No match in the multiplier table
 * → returns score unchanged.
 */
export function applyTypeMultiplier(
  score: number,
  type: MemoryType,
  multipliers: Partial<Record<MemoryType, number>>,
): number {
  const m = multipliers[type];
  return m === undefined ? score : score * m;
}
