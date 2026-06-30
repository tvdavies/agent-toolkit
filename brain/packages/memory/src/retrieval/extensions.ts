import type {
  ExtensionCandidateGenerator,
  ExtensionRanker,
  ExtensionRecallCandidate,
  ExtensionSelector,
} from "../memory.js";
import type { Storage } from "../storage/sqlite.js";
import type { RetrievalHit } from "./types.js";

export interface ExtensionStageOptions {
  query: string;
  recallModuleEnabled(id: string): boolean;
}

export async function applyExtensionCandidateGenerators(
  opts: ExtensionStageOptions & {
    hits: RetrievalHit[];
    storage: Storage;
    generators: readonly ExtensionCandidateGenerator[];
  },
): Promise<RetrievalHit[]> {
  const byId = new Map(opts.hits.map((hit) => [hit.chunk.id, hit]));
  for (const generator of opts.generators) {
    if (!opts.recallModuleEnabled(generator.id)) continue;
    const existing = [...byId.values()].map(hitToCandidate);
    const generated = await generator.generate(existing, opts.query);
    for (const candidate of generated) {
      if (byId.has(candidate.id)) continue;
      const chunk = opts.storage.getChunk(candidate.id);
      if (chunk === undefined) continue;
      byId.set(candidate.id, {
        chunk,
        score: candidate.score,
        contributions: {},
        scoring: { rrfBase: candidate.score, rerankerRanked: false },
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

export async function applyExtensionRankers(
  opts: ExtensionStageOptions & {
    hits: RetrievalHit[];
    rankers: readonly ExtensionRanker[];
  },
): Promise<RetrievalHit[]> {
  let ranked = opts.hits;
  for (const ranker of opts.rankers) {
    if (!opts.recallModuleEnabled(ranker.id)) continue;
    const byId = new Map(ranked.map((hit) => [hit.chunk.id, hit]));
    const next = await ranker.rank(ranked.map(hitToCandidate), opts.query);
    ranked = next.flatMap((candidate) => {
      const hit = byId.get(candidate.id);
      if (hit === undefined) return [];
      hit.score = candidate.score;
      return [hit];
    });
  }
  return ranked;
}

export async function applyExtensionSelectors(
  opts: ExtensionStageOptions & {
    hits: RetrievalHit[];
    selectors: readonly ExtensionSelector[];
  },
): Promise<RetrievalHit[]> {
  let selected = opts.hits;
  for (const selector of opts.selectors) {
    if (!opts.recallModuleEnabled(selector.id)) continue;
    const byId = new Map(selected.map((hit) => [hit.chunk.id, hit]));
    const next = await selector.select(selected.map(hitToCandidate), opts.query);
    selected = next.flatMap((candidate) => {
      const hit = byId.get(candidate.id);
      if (hit === undefined) return [];
      hit.score = candidate.score;
      return [hit];
    });
  }
  return selected;
}

function hitToCandidate(hit: RetrievalHit): ExtensionRecallCandidate {
  return {
    id: hit.chunk.id,
    score: hit.score,
    source: "memory",
    ...(hit.chunk.metadata !== undefined ? { metadata: hit.chunk.metadata } : {}),
  };
}
