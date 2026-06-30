import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WriteEvent } from "./types.js";

export type Fact = {
  type: "fact" | "preference" | "event" | "decision" | "context";
  content: string;
  entities?: string[];
  topics?: string[];
  supersedes?: string;
};

export interface FactCache {
  /** Returns cached facts if hit; undefined on miss. */
  get(group: readonly WriteEvent[]): Fact[] | undefined;
  /** Stores facts under the same key the next get() will look up. */
  set(group: readonly WriteEvent[], facts: Fact[]): void;
  /** Hits since construction. Diagnostics only. */
  readonly hits: number;
  /** Misses since construction. Diagnostics only. */
  readonly misses: number;
}

export type FactCacheOptions = {
  /** Filesystem directory where cache files live. Created if missing. */
  cacheDir: string;
  /**
   * Identifies the extractor's model + prompt so unrelated configurations
   * don't collide. Recommended form: `"<model-id>:<prompt-version>"`.
   * E.g. `"google/gemini-3-flash:v1"` or `"local/gemma-4-e2b:v1"`.
   */
  cacheKey: string;
};

/**
 * Content-addressed JSON cache for extractor LLM calls. LongMemEval
 * haystacks are static and the extractor runs at temperature 0, so per-
 * group output is stable across runs. Caching lets us re-run extraction-
 * stack experiments in actor-only time (~10 min) instead of paying full
 * extraction wall-time (~50 min).
 *
 * Key = SHA256(canonical-JSON({ key, group })). One JSON file per key
 * under `cacheDir/`. No dependencies on a SQLite layer; the cache is
 * trivially clearable with `rm -rf`.
 *
 * Cache invalidation is the caller's job: bump `cacheKey` when the
 * extraction prompt or model changes in a way that would alter outputs.
 */
export function createFactCache(opts: FactCacheOptions): FactCache {
  mkdirSync(opts.cacheDir, { recursive: true });
  let hits = 0;
  let misses = 0;

  // Cache key is derived from the LLM-visible content only — the kind +
  // text/content fields. `recordedAt` and other metadata don't reach the
  // model, so including them would invalidate the cache without changing
  // outputs.
  const pathFor = (group: readonly WriteEvent[]): string => {
    const visible = group.map((e) =>
      e.kind === "ingested-item"
        ? { kind: e.kind, content: e.content }
        : e.kind === "tool-call"
          ? { kind: e.kind, tool: e.tool, args: e.args, result: e.result }
          : { kind: e.kind, text: e.text },
    );
    const payload = JSON.stringify({ k: opts.cacheKey, g: visible });
    const hash = createHash("sha256").update(payload).digest("hex");
    return join(opts.cacheDir, `${hash}.json`);
  };

  return {
    get(group) {
      try {
        const raw = readFileSync(pathFor(group), "utf8");
        const parsed = JSON.parse(raw) as { facts: Fact[] };
        hits++;
        return parsed.facts;
      } catch {
        misses++;
        return undefined;
      }
    },
    set(group, facts) {
      writeFileSync(pathFor(group), JSON.stringify({ facts }));
    },
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
  };
}
