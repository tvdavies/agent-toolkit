/**
 * Typed-edge inference (port of GBrain's `link-extraction.ts`).
 *
 * Extracts `[[…]]` and `[[scope:…]]` wikilinks plus loose entity
 * mentions from a fact body, then assigns each candidate edge a
 * relationship type via a deterministic regex bank — zero LLM
 * calls. The regex bank is calibrated for LongMemEval-style
 * conversational lifelog prose (attended events, made decisions,
 * preferences about food/products, travel, family, work) rather
 * than GBrain's VC/founder corpus, but the structural pattern is
 * the same: per-edge verb match first, fall back to a category
 * default.
 *
 * Each emitted edge ends up in the `edges` SQLite table with
 * `link_type ∈ { attended, decided, prefers, dislikes, owns,
 * visited, met, mentions, ... }` plus the surrounding ~240-char
 * prose window for context.
 */

import type { MemoryType } from "../storage/markdown-store.js";
import type { Edge } from "../storage/sqlite.js";

const WIKILINK_RE = /\[\[([^|\]]+?)(?:\|([^\]]+?))?\]\]/g;
const QUALIFIED_WIKILINK_RE = /\[\[([a-z0-9][a-z0-9_/-]{0,60}):([^|\]]+?)(?:\|([^\]]+?))?\]\]/g;

const ATTENDED_RE =
  /\b(?:attended|went to|going to|was at|showed up at|present at|joined .{0,15}? (?:wedding|funeral|conference|meetup|party|celebration|ceremony|gathering|event)|celebrated .{0,20}? at)\b/i;

const DECIDED_RE =
  /\b(?:decided to|decided that|chose to|chose .{0,30}? (?:over|instead)|agreed to|committed to|opted for|opted to|going with|switched to|going to switch)\b/i;

const PREFERS_RE =
  /\b(?:prefer(?:s|red)?|like(?:s|d)?|love(?:s|d)?|enjoy(?:s|ed)?|favou?rite|always (?:order|orders|gets|chooses)|usually (?:order|orders|gets|chooses)|tends? to (?:order|get|choose|prefer))\b/i;

const DISLIKES_RE =
  /\b(?:dislike(?:s|d)?|hate(?:s|d)?|avoid(?:s|ed)?|refuses?|can't stand|cannot stand)\b/i;

const OWNS_RE =
  /\b(?:bought|purchased|owns?|owned|got a (?:new |second-?hand )?|acquired|received)\b/i;

const VISITED_RE =
  /\b(?:visited|visiting|travel(?:l?ed|ling)? to|moved to|moving to|flew to|drove to|stayed (?:at|in)|holiday(?:ed|ing)? in|vacation(?:ed|ing)? in|trip to)\b/i;

const MET_RE =
  /\b(?:met (?:up )?with|met|introduced to|had (?:dinner|lunch|coffee|drinks|breakfast) with|caught up with|hung out with)\b/i;

const CONSUMED_RE =
  /\b(?:ate|eaten|tried|tasting|tasted|cooked|baked|ordered|drank|drunk|sampled)\b/i;

const STARTED_RE =
  /\b(?:started (?:to |a |the )?|began (?:to )?|took up|joined|enrolled in|signed up for|picked up)\b/i;

const ENDED_RE = /\b(?:quit|stopped|left|gave up|ended|finished|completed|graduated from)\b/i;

const CONSUMED_MEDIA_RE =
  /\b(?:watched|watching|read (?:the |a )?|reading|listened to|listening to|streaming|playing|played)\b/i;

function defaultLinkTypeForType(type: MemoryType): string {
  switch (type) {
    case "events":
      return "attended";
    case "preferences":
      return "prefers";
    case "decisions":
      return "decided";
    case "facts":
      return "mentions";
    case "observations":
      return "mentions";
    case "aggregates":
      return "summarises";
    case "context":
      return "mentions";
    case "episodic":
      return "mentions";
    case "reflections":
      return "reflects_on";
    case "patterns":
      return "exemplifies";
    case "procedural":
      return "uses_tool";
  }
}

/**
 * Per-edge inference. Looks at the prose window around an entity
 * mention; if a verb pattern fires, that wins. Otherwise falls back
 * to the page-category default. Specific verbs (consumed, started,
 * ended) are evaluated before generic ones (prefers, mentions).
 */
export function inferLinkType(context: string, type: MemoryType): string {
  if (ATTENDED_RE.test(context)) return "attended";
  if (DECIDED_RE.test(context)) return "decided";
  if (DISLIKES_RE.test(context)) return "dislikes";
  if (PREFERS_RE.test(context)) return "prefers";
  if (OWNS_RE.test(context)) return "owns";
  if (VISITED_RE.test(context)) return "visited";
  if (MET_RE.test(context)) return "met";
  if (CONSUMED_MEDIA_RE.test(context)) return "consumed_media";
  if (CONSUMED_RE.test(context)) return "consumed";
  if (STARTED_RE.test(context)) return "started";
  if (ENDED_RE.test(context)) return "ended";
  return defaultLinkTypeForType(type);
}

export type WikilinkRef = {
  targetSlug: string;
  scope?: string;
  displayName?: string;
  context: string;
};

function stripCodeBlocks(content: string): string {
  let out = "";
  let i = 0;
  while (i < content.length) {
    if (content.startsWith("```", i)) {
      const end = content.indexOf("```", i + 3);
      if (end === -1) {
        out += " ".repeat(content.length - i);
        break;
      }
      out += " ".repeat(end + 3 - i);
      i = end + 3;
      continue;
    }
    if (content[i] === "`") {
      const end = content.indexOf("`", i + 1);
      if (end === -1 || content.slice(i + 1, end).includes("\n")) {
        out += content[i];
        i++;
        continue;
      }
      out += " ".repeat(end + 1 - i);
      i = end + 1;
      continue;
    }
    out += content[i];
    i++;
  }
  return out;
}

function maskRanges(content: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return content;
  const chars = content.split("");
  for (const [s, e] of ranges) {
    for (let i = s; i < e && i < chars.length; i++) chars[i] = " ";
  }
  return chars.join("");
}

function excerpt(s: string, idx: number, width = 240): string {
  const half = Math.floor(width / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(s.length, idx + half);
  return s.slice(start, end).replace(/\s+/g, " ").trim();
}

export function extractWikilinks(body: string): WikilinkRef[] {
  const stripped = stripCodeBlocks(body);
  const refs: WikilinkRef[] = [];

  const qualifiedRanges: Array<[number, number]> = [];
  const qualPattern = new RegExp(QUALIFIED_WIKILINK_RE.source, QUALIFIED_WIKILINK_RE.flags);
  let match: RegExpExecArray | null = qualPattern.exec(stripped);
  while (match !== null) {
    const scope = match[1] as string;
    const targetSlug = (match[2] as string).trim();
    if (targetSlug === "") {
      match = qualPattern.exec(stripped);
      continue;
    }
    // Filter URL-shaped accidents: `[[https://example.com]]` parses as
    // scope=https, target=//example.com via the qualified pattern.
    if (/^https?$/.test(scope) || targetSlug.startsWith("//")) {
      qualifiedRanges.push([match.index, match.index + match[0].length]);
      match = qualPattern.exec(stripped);
      continue;
    }
    const displayName = match[3]?.trim();
    refs.push({
      scope,
      targetSlug,
      ...(displayName ? { displayName } : {}),
      context: excerpt(stripped, match.index),
    });
    qualifiedRanges.push([match.index, match.index + match[0].length]);
    match = qualPattern.exec(stripped);
  }

  const unmasked = maskRanges(stripped, qualifiedRanges);
  const wikiPattern = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
  match = wikiPattern.exec(unmasked);
  while (match !== null) {
    const targetSlug = (match[1] as string).trim();
    if (targetSlug === "" || targetSlug.includes("://")) {
      match = wikiPattern.exec(unmasked);
      continue;
    }
    const displayName = match[2]?.trim();
    refs.push({
      targetSlug,
      ...(displayName ? { displayName } : {}),
      context: excerpt(stripped, match.index),
    });
    match = wikiPattern.exec(unmasked);
  }

  return refs;
}

export type EntityMention = {
  entity: string;
  context: string;
};

export function extractEntityMentions(body: string, entities: readonly string[]): EntityMention[] {
  if (entities.length === 0) return [];
  const stripped = stripCodeBlocks(body);
  const out: EntityMention[] = [];
  const lower = stripped.toLowerCase();
  const seen = new Set<string>();
  for (const e of entities) {
    const trimmed = e.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const idx = lower.indexOf(key);
    const ctx = idx >= 0 ? excerpt(stripped, idx) : stripped.slice(0, 240);
    out.push({ entity: trimmed, context: ctx });
  }
  return out;
}

export type ExtractPageEdgesInput = {
  fromChunkId: string;
  body: string;
  type: MemoryType;
  entities?: readonly string[];
  resolveSlug?: (slug: string, scope?: string) => string | undefined;
};

export function extractPageEdges(input: ExtractPageEdgesInput): Edge[] {
  const out: Edge[] = [];
  const seen = new Set<string>();
  const push = (edge: Edge): void => {
    const key = `${edge.toChunkId ?? ""} ${edge.toEntity ?? ""} ${edge.linkType} ${edge.linkSource ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(edge);
  };

  for (const m of extractEntityMentions(input.body, input.entities ?? [])) {
    push({
      fromChunkId: input.fromChunkId,
      toEntity: m.entity.toLowerCase(),
      linkType: inferLinkType(m.context, input.type),
      context: m.context,
      linkSource: "markdown",
    });
  }

  for (const w of extractWikilinks(input.body)) {
    const resolved = input.resolveSlug?.(w.targetSlug, w.scope);
    push({
      fromChunkId: input.fromChunkId,
      ...(resolved ? { toChunkId: resolved } : { toEntity: w.targetSlug.toLowerCase() }),
      linkType: inferLinkType(w.context, input.type),
      context: w.context,
      linkSource: "wikilink",
    });
  }

  return out;
}
