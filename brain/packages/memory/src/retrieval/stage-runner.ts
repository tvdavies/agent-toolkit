import { applyBuiltInBoosts, type BoostResult } from "./boosts.js";
import type { BuiltInRecallServices } from "./builtin-stages.js";
import { type CandidateGenerationResult, generateCandidateLists } from "./candidates.js";
import { type FinalizeRetrievalResult, finalizeRetrieval } from "./finalize.js";
import { fuseCandidateLists } from "./pipeline.js";
import { type PreparedRecall, prepareRecall } from "./prepare.js";
import type { RetrievalHit } from "./types.js";

export function runPrepareStage(
  services: BuiltInRecallServices,
  recallModuleEnabled: (id: string) => boolean,
): PreparedRecall {
  return prepareRecall({
    input: services.input,
    defaultTopK: services.defaultTopK,
    ...(services.pathBoostTopK !== undefined ? { pathBoostTopK: services.pathBoostTopK } : {}),
    hasEmbedders: services.embedders.length > 0,
    recallModuleEnabled,
  });
}

export async function runCandidateStage(
  services: BuiltInRecallServices,
  prepared: PreparedRecall,
  primaryStorage: NonNullable<BuiltInRecallServices["storages"][number]>,
  recallModuleEnabled: (id: string) => boolean,
): Promise<CandidateGenerationResult> {
  const queries =
    services.queryExpander !== undefined
      ? await services.queryExpander.expand(prepared.effectiveQuery)
      : [prepared.effectiveQuery];
  return generateCandidateLists({
    input: services.input,
    queries,
    intent: prepared.intent,
    primaryStorage,
    storages: services.storages,
    embedders: services.embedders,
    embedderWeights: services.embedderWeights,
    entityIndex: services.entityIndex,
    candidateK: services.candidateK,
    fallbackQueryRewriter: services.fallbackQueryRewriter,
    recallModuleEnabled,
  });
}

export function runFuseStage(generated: CandidateGenerationResult): RetrievalHit[] {
  return fuseCandidateLists(generated.lists);
}

export function runBoostStage(
  services: BuiltInRecallServices,
  prepared: PreparedRecall,
  primaryStorage: NonNullable<BuiltInRecallServices["storages"][number]>,
  hits: RetrievalHit[],
  recallModuleEnabled: (id: string) => boolean,
): BoostResult {
  return applyBuiltInBoosts({
    hits,
    input: services.input,
    intent: prepared.intent,
    primaryStorage,
    entityIndex: services.entityIndex,
    recallModuleEnabled,
  });
}

export async function runFinalizeStage(
  services: BuiltInRecallServices,
  prepared: PreparedRecall,
  hits: RetrievalHit[],
  decayActive: boolean,
  recallModuleEnabled: (id: string) => boolean,
): Promise<FinalizeRetrievalResult> {
  return finalizeRetrieval({
    hits,
    query: services.input.query,
    topK: prepared.topK,
    skipReranker: services.input.skipReranker,
    reranker: services.reranker,
    shouldRunReranker: recallModuleEnabled("brain/reranker"),
    shouldSort:
      prepared.intent.pathMultipliers !== undefined ||
      decayActive ||
      prepared.intent.assistantReferenceBias === true ||
      hits.length > 0,
  });
}
