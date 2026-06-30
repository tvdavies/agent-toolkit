import type { RetrievalResult } from "@ai-assistant/contracts";
import type { Chunk } from "../storage/types.js";
import { RRF_DEFAULT_K, reciprocalRankFusion } from "./rrf.js";
import { renderChunkContent } from "./temporal.js";
import type { RetrievalHit } from "./types.js";

export type RetrievalCandidateSource = {
  kind: "bm25" | "vector" | "entity";
  score: number;
  chunk: Chunk;
};

export type RetrievalCandidateList = {
  weight: number;
  candidates: { id: string; rank: number; source: RetrievalCandidateSource }[];
};

export interface RetrievalDiagnosticsInput {
  bm25Hits: number;
  vectorHits: number;
  rerankerRan: boolean;
  bm25RetryAttempts: number;
}

/** Fuse weighted candidate lists with RRF and hydrate them into retrieval hits. */
export function fuseCandidateLists(lists: readonly RetrievalCandidateList[]): RetrievalHit[] {
  const fused = reciprocalRankFusion<RetrievalCandidateSource>(lists, RRF_DEFAULT_K);
  return fused.map((result) => {
    const first = result.contributions[0];
    if (first === undefined) throw new Error("RRF result without contributions");
    const contributions: { bm25?: number; vector?: number; entity?: number } = {};
    for (const contribution of result.contributions)
      contributions[contribution.kind] = contribution.score;
    return {
      chunk: first.chunk,
      score: result.score,
      contributions,
      scoring: { rrfBase: result.score, rerankerRanked: false },
    };
  });
}

/** Sort retrieval hits by descending score. Kept small and explicit for staged pipeline migration. */
export function sortByScore(hits: RetrievalHit[]): RetrievalHit[] {
  return hits.sort((a, b) => b.score - a.score);
}

/** Select the first `topK` hits. Future selector modules replace this helper. */
export function selectTopK(hits: readonly RetrievalHit[], topK: number): RetrievalHit[] {
  return hits.slice(0, topK);
}

/** Convert internal retrieval hits into the public RetrievalResult contract. */
export function buildRetrievalResult(
  hits: readonly RetrievalHit[],
  diagnostics: RetrievalDiagnosticsInput,
): RetrievalResult {
  const recallableHits = hits.filter(
    (hit) => hit.chunk.type !== "episodic" && hit.chunk.metadata?.recallable !== false,
  );
  return {
    items: recallableHits.map((hit) => ({
      id: hit.chunk.id,
      content: renderChunkContent(hit.chunk.content, hit.chunk.metadata),
      source: {
        kind: "memory" as const,
        id: hit.chunk.path,
        ...(typeof hit.chunk.metadata?.sourceUri === "string"
          ? { url: hit.chunk.metadata.sourceUri }
          : {}),
        ...(typeof hit.chunk.metadata?.sourceTitle === "string"
          ? { title: hit.chunk.metadata.sourceTitle }
          : {}),
      },
      score: hit.score,
      entities: [],
      writtenAt: new Date(),
      ...(hit.scoring !== undefined
        ? {
            scoring: {
              rrfBase: hit.scoring.rrfBase,
              contributions: hit.contributions ?? {},
              ...(hit.scoring.cosineBlend !== undefined
                ? { cosineBlend: hit.scoring.cosineBlend }
                : {}),
              ...(hit.scoring.typeMultiplier !== undefined
                ? { typeMultiplier: hit.scoring.typeMultiplier }
                : {}),
              ...(hit.scoring.decayMultiplier !== undefined
                ? { decayMultiplier: hit.scoring.decayMultiplier }
                : {}),
              ...(hit.scoring.assistantBoost !== undefined
                ? { assistantBoost: hit.scoring.assistantBoost }
                : {}),
              ...(hit.scoring.backlinkBoost !== undefined
                ? { backlinkBoost: hit.scoring.backlinkBoost }
                : {}),
              ...(hit.scoring.authorityMultiplier !== undefined
                ? { authorityMultiplier: hit.scoring.authorityMultiplier }
                : {}),
              ...(hit.scoring.usageMultiplier !== undefined
                ? { usageMultiplier: hit.scoring.usageMultiplier }
                : {}),
              ...(hit.scoring.statusMultiplier !== undefined
                ? { statusMultiplier: hit.scoring.statusMultiplier }
                : {}),
              rerankerRanked: hit.scoring.rerankerRanked,
              finalScore: hit.score,
            },
          }
        : {}),
    })),
    diagnostics: {
      bm25Hits: diagnostics.bm25Hits,
      vectorHits: diagnostics.vectorHits,
      rerankerRan: diagnostics.rerankerRan,
      ...(diagnostics.bm25RetryAttempts > 0
        ? { bm25RetryAttempts: diagnostics.bm25RetryAttempts }
        : {}),
    },
  };
}
