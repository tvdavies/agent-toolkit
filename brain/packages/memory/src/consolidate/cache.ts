import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ConsolidatedAggregate = {
  /** Canonical entity slug, e.g. "wedding", "charity-event". */
  entity: string;
  /** Pre-computed summary content. */
  content: string;
  /** Optional list of fact ordinals this aggregate covers. */
  coversOrdinals?: number[];
};

export interface ConsolidationCache {
  get(facts: readonly { content: string; entity: string }[]): ConsolidatedAggregate | undefined;
  set(
    facts: readonly { content: string; entity: string }[],
    aggregate: ConsolidatedAggregate,
  ): void;
  readonly hits: number;
  readonly misses: number;
}

export type ConsolidationCacheOptions = {
  cacheDir: string;
  /** Identifies model + prompt so configurations don't collide. */
  cacheKey: string;
};

/**
 * Content-addressed JSON cache for consolidator LLM calls. Key derived
 * from the (entity-grouped, sorted) fact contents — the LLM-visible
 * payload — so cache stays valid across writer-side metadata changes.
 */
export function createConsolidationCache(opts: ConsolidationCacheOptions): ConsolidationCache {
  mkdirSync(opts.cacheDir, { recursive: true });
  let hits = 0;
  let misses = 0;

  const pathFor = (facts: readonly { content: string; entity: string }[]): string => {
    // Stable order — sort fact contents so insertion order doesn't
    // change the hash. The entity is the same across the group.
    const sorted = [...facts].sort((a, b) => a.content.localeCompare(b.content));
    const visible = { entity: sorted[0]?.entity, contents: sorted.map((f) => f.content) };
    const payload = JSON.stringify({ k: opts.cacheKey, g: visible });
    const hash = createHash("sha256").update(payload).digest("hex");
    return join(opts.cacheDir, `${hash}.json`);
  };

  return {
    get(facts) {
      try {
        const raw = readFileSync(pathFor(facts), "utf8");
        const parsed = JSON.parse(raw) as ConsolidatedAggregate;
        hits++;
        return parsed;
      } catch {
        misses++;
        return undefined;
      }
    },
    set(facts, aggregate) {
      writeFileSync(pathFor(facts), JSON.stringify(aggregate));
    },
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
  };
}
