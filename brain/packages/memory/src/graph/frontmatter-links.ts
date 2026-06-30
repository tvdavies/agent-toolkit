/**
 * Frontmatter-derived edges (port of GBrain's FRONTMATTER_LINK_MAP).
 *
 * Memory files carry structured YAML frontmatter — `entities`,
 * `topics`, `recordedAt`, `priority`, etc. Some of those fields
 * map naturally to typed graph edges:
 *
 *   entities: [Sarah, Mike]   →  edges (mentions, to_entity=Sarah)
 *                              + edges (mentions, to_entity=Mike)
 *   topics:   [wedding]       →  edges (covers_topic, to_entity=wedding)
 *   supersedes: [[wedding-2024-03-15-sarah-mike]]
 *                             →  edge (supersedes, to_chunk_id=…)
 *   participants: [Sarah, Mike]
 *                             →  edges (attended, to_entity=Sarah, …)
 *
 * Frontmatter edges are emitted alongside body-derived edges
 * (link-inference.ts) at write time. They have provenance
 * `link_source = 'frontmatter'` so the daemon can scope cleanups to
 * edges THIS file's frontmatter authored, never touching edges other
 * files created.
 */

import type { Frontmatter } from "../storage/frontmatter.js";
import type { Edge } from "../storage/sqlite.js";

type FieldRule = {
  /** Frontmatter field name (or aliases). */
  fields: readonly string[];
  /** Edge type emitted for each value. */
  linkType: string;
};

/**
 * Canonical map: frontmatter field → edge type. Each value in the
 * field becomes an edge from the page being written (`fromChunkId`)
 * to a free-text entity (`toEntity`). Wikilink resolution is the
 * caller's job — when a value happens to be a slug, the resolver
 * upgrades the edge to a chunk-to-chunk reference at write time.
 *
 * Order is irrelevant: edges are deduped by
 * (from, to, linkType, linkSource) at upsert.
 */
const FIELD_RULES: readonly FieldRule[] = [
  { fields: ["entities", "participants"], linkType: "mentions" },
  { fields: ["attendees"], linkType: "attended" },
  { fields: ["topics"], linkType: "covers_topic" },
  { fields: ["supersedes"], linkType: "supersedes" },
  { fields: ["superseded_by"], linkType: "superseded_by" },
  { fields: ["mentioned_companies", "companies"], linkType: "mentions" },
  { fields: ["key_people"], linkType: "key_person" },
  { fields: ["investors"], linkType: "invested_in" },
];

export type FrontmatterLinksInput = {
  fromChunkId: string;
  frontmatter: Frontmatter;
  resolveSlug?: (slug: string, scope?: string) => string | undefined;
};

/**
 * Walk a chunk's frontmatter, emit one Edge per (rule × value).
 * Pure; the caller is responsible for upsert + dedup.
 */
export function extractFrontmatterEdges(input: FrontmatterLinksInput): Edge[] {
  const out: Edge[] = [];
  const seen = new Set<string>();
  const push = (edge: Edge): void => {
    const key = `${edge.toChunkId ?? ""} ${edge.toEntity ?? ""} ${edge.linkType}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(edge);
  };

  for (const rule of FIELD_RULES) {
    for (const field of rule.fields) {
      const raw = input.frontmatter[field];
      if (raw === undefined) continue;
      const values = normaliseValues(raw);
      for (const value of values) {
        const wikilinkSlug = matchBareWikilinkSlug(value);
        const slug = wikilinkSlug ?? slugCandidate(value);
        const resolved = slug !== undefined ? input.resolveSlug?.(slug) : undefined;
        push({
          fromChunkId: input.fromChunkId,
          ...(resolved !== undefined
            ? { toChunkId: resolved }
            : { toEntity: value.trim().toLowerCase() }),
          linkType: rule.linkType,
          context: `frontmatter:${field}`,
          linkSource: "frontmatter",
        });
      }
    }
  }
  return out;
}

/** A frontmatter array value can be a string or an `[a, b]` array. */
function normaliseValues(raw: unknown): string[] {
  if (typeof raw === "string") return raw.trim() === "" ? [] : [raw.trim()];
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const v of raw) {
      if (typeof v === "string" && v.trim() !== "") out.push(v.trim());
    }
    return out;
  }
  return [];
}

/** `[[some-slug]]` or `[[some-slug|Display]]` → `some-slug`. */
function matchBareWikilinkSlug(value: string): string | undefined {
  const m = value.match(/^\[\[([^|\]]+?)(?:\|[^\]]+?)?\]\]$/);
  return m?.[1]?.trim();
}

/** Heuristic: a bare slug-looking string is a candidate for resolution. */
function slugCandidate(value: string): string | undefined {
  if (/^[a-z0-9][a-z0-9-]{2,}(?:\/[a-z0-9-]+)*$/.test(value)) return value;
  return undefined;
}
