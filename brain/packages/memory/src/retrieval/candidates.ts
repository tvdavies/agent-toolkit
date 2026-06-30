import type { RetrievalInput } from "@ai-assistant/contracts";
import type { Embedder } from "../embedding/index.js";
import type { Storage } from "../storage/sqlite.js";
import type { Chunk } from "../storage/types.js";
import { type EntityIndex, extractQueryEntities } from "./entity.js";
import type { FallbackQueryRewriter } from "./fallback-rewrite.js";
import { shouldFallbackRewrite } from "./fallback-rewrite.js";
import type { IntentClassification } from "./intent.js";
import type { RetrievalCandidateList } from "./pipeline.js";
import { searchBM25WithRetry } from "./retry.js";

export interface CandidateGenerationOptions {
  input: RetrievalInput;
  queries: readonly string[];
  intent: IntentClassification;
  primaryStorage: Storage;
  storages: readonly Storage[];
  embedders: readonly Embedder[];
  embedderWeights: readonly number[];
  entityIndex: EntityIndex;
  candidateK: number;
  fallbackQueryRewriter?: FallbackQueryRewriter;
  recallModuleEnabled(id: string): boolean;
}

export interface CandidateGenerationResult {
  lists: RetrievalCandidateList[];
  diagnostics: {
    bm25Hits: number;
    vectorHits: number;
    bm25RetryAttempts: number;
  };
}

/** Generate weighted candidate lists for BM25, vector, entity, and fallback rewrite legs. */
export async function generateCandidateLists(
  opts: CandidateGenerationOptions,
): Promise<CandidateGenerationResult> {
  const lists: RetrievalCandidateList[] = [];
  let bm25Hits = 0;
  let vectorHits = 0;
  let bm25RetryAttempts = 0;

  for (const query of opts.queries) {
    if (opts.recallModuleEnabled("brain/bm25") && opts.intent.weights.bm25 > 0) {
      const bm25 = searchBM25WithRetry(opts.primaryStorage, query, opts.candidateK);
      bm25Hits += bm25.hits.length;
      bm25RetryAttempts += Math.max(0, bm25.attempts.length - 1);
      lists.push({
        weight: opts.intent.weights.bm25,
        candidates: bm25.hits.map((hit, rank) => ({
          id: hit.chunk.id,
          rank,
          source: { kind: "bm25", score: hit.score, chunk: hit.chunk },
        })),
      });
    }

    if (
      opts.recallModuleEnabled("brain/vector") &&
      opts.intent.weights.vector > 0 &&
      opts.embedders.length > 0 &&
      opts.input.skipEmbed !== true
    ) {
      const queryEmbeddings = await Promise.all(
        opts.embedders.map(async (embedder) => (await embedder.embed([query]))[0]),
      );
      for (let i = 0; i < opts.embedders.length; i++) {
        const embedding = queryEmbeddings[i];
        const storage = opts.storages[i];
        if (embedding === undefined || storage === undefined) continue;
        const hits = storage.searchVector(embedding, opts.candidateK);
        vectorHits += hits.length;
        lists.push({
          weight: opts.intent.weights.vector * (opts.embedderWeights[i] ?? 1),
          candidates: hits.map((hit, rank) => ({
            id: hit.chunk.id,
            rank,
            source: { kind: "vector", score: hit.score, chunk: hit.chunk },
          })),
        });
      }
    }
  }

  addEntityCandidates(opts, lists);

  if (shouldRunFallback(opts, lists, bm25Hits, vectorHits)) {
    const rewrites = (await opts.fallbackQueryRewriter?.rewrite(opts.input.query)) ?? [];
    for (const rewrite of rewrites.slice(0, 3)) {
      const bm25 = searchBM25WithRetry(opts.primaryStorage, rewrite, opts.candidateK);
      bm25Hits += bm25.hits.length;
      bm25RetryAttempts += Math.max(0, bm25.attempts.length - 1);
      if (bm25.hits.length === 0) continue;
      lists.push({
        weight: opts.intent.weights.bm25 || 1,
        candidates: bm25.hits.map((hit, rank) => ({
          id: hit.chunk.id,
          rank,
          source: { kind: "bm25", score: hit.score, chunk: hit.chunk },
        })),
      });
      break;
    }
  }

  return { lists, diagnostics: { bm25Hits, vectorHits, bm25RetryAttempts } };
}

function addEntityCandidates(
  opts: CandidateGenerationOptions,
  lists: RetrievalCandidateList[],
): void {
  const queryEntities = extractQueryEntities(opts.input.query).filter((entity) =>
    entity.includes(" "),
  );
  if (!opts.recallModuleEnabled("brain/entity") || queryEntities.length === 0) return;
  const matchedIds = opts.entityIndex.findChunksByQueryEntities(queryEntities);
  for (const id of opts.primaryStorage.findChunksByEntities(queryEntities)) matchedIds.add(id);
  if (matchedIds.size === 0) return;

  const chunks: Chunk[] = [];
  for (const id of matchedIds) {
    const chunk = opts.primaryStorage.getChunk(id);
    if (chunk !== undefined && chunk.metadata?.recallable !== false) chunks.push(chunk);
  }
  chunks.sort((a, b) => b.ordinal - a.ordinal);
  lists.push({
    weight: 0.7,
    candidates: chunks.slice(0, opts.candidateK).map((chunk, rank) => ({
      id: chunk.id,
      rank,
      source: { kind: "entity", score: 1, chunk },
    })),
  });
}

function shouldRunFallback(
  opts: CandidateGenerationOptions,
  lists: RetrievalCandidateList[],
  bm25Hits: number,
  vectorHits: number,
): boolean {
  return (
    shouldFallbackRewrite({
      bm25Hits,
      vectorHits,
      entityHits: lists.filter((list) =>
        list.candidates.some((candidate) => candidate.source.kind === "entity"),
      ).length,
    }) &&
    opts.recallModuleEnabled("brain/fallback-query-rewrite") &&
    opts.fallbackQueryRewriter !== undefined
  );
}
