import type { RetrievalResult } from "@ai-assistant/contracts";
import {
  EXECUTABLE_BUILT_IN_RECALL_MODULES,
  type RecallExecutionState,
} from "./builtin-handlers.js";
import type { BuiltInRecallServices } from "./builtin-stages.js";
import {
  applyExtensionCandidateGenerators,
  applyExtensionRankers,
  applyExtensionSelectors,
} from "./extensions.js";
import { RecallModulePlan } from "./modules.js";
import { buildRetrievalResult } from "./pipeline.js";

export interface RecallPipelineOptions extends BuiltInRecallServices {
  recallModuleEnabled(id: string): boolean;
}

/** Run the legacy-compatible recall pipeline through explicit typed stages. */
export async function runRecallPipeline(opts: RecallPipelineOptions): Promise<RetrievalResult> {
  const primaryStorage = opts.storages[0];
  if (primaryStorage === undefined) {
    return { items: [], diagnostics: { bm25Hits: 0, vectorHits: 0, rerankerRan: false } };
  }

  const plan = new RecallModulePlan(enabledIds(opts));
  const state: RecallExecutionState = { hits: [], decayActive: false };
  const handlerContext = {
    services: opts,
    primaryStorage,
    state,
    isEnabled: (id: string) => opts.recallModuleEnabled(id),
  };

  for (const module of plan.enabledBuiltIns(EXECUTABLE_BUILT_IN_RECALL_MODULES)) {
    if (module.stage === "rank") continue;
    await module.run(handlerContext);
  }

  let hits = state.hits;

  if (opts.extensionCandidateGenerators.length > 0) {
    hits = await applyExtensionCandidateGenerators({
      query: opts.input.query,
      hits,
      storage: primaryStorage,
      generators: opts.extensionCandidateGenerators,
      recallModuleEnabled: opts.recallModuleEnabled,
    });
  }

  if (opts.extensionRankers.length > 0 && hits.length > 0) {
    hits = await applyExtensionRankers({
      query: opts.input.query,
      hits,
      rankers: opts.extensionRankers,
      recallModuleEnabled: opts.recallModuleEnabled,
    });
  }

  state.hits = hits;
  for (const module of plan.enabledBuiltIns(EXECUTABLE_BUILT_IN_RECALL_MODULES)) {
    if (module.stage !== "rank") continue;
    await module.run(handlerContext);
  }

  const finalized = state.finalized ?? { hits: state.hits, rerankerRan: false };
  let selected = finalized.hits;
  if (opts.extensionSelectors.length > 0 && selected.length > 0) {
    selected = await applyExtensionSelectors({
      query: opts.input.query,
      hits: selected,
      selectors: opts.extensionSelectors,
      recallModuleEnabled: opts.recallModuleEnabled,
    });
  }

  if (selected.length > 0) {
    const ids = selected.map((hit) => hit.chunk.id);
    for (const storage of opts.storages) storage.bumpRetrievalCounters(ids);
  }

  return buildRetrievalResult(selected, {
    bm25Hits: state.generated?.diagnostics.bm25Hits ?? 0,
    vectorHits: state.generated?.diagnostics.vectorHits ?? 0,
    rerankerRan: finalized.rerankerRan,
    bm25RetryAttempts: state.generated?.diagnostics.bm25RetryAttempts ?? 0,
  });
}

function enabledIds(opts: RecallPipelineOptions): string[] {
  const explicit = EXECUTABLE_BUILT_IN_RECALL_MODULES.filter((module) =>
    opts.recallModuleEnabled(module.id),
  ).map((module) => module.id);
  // Preparation computes fallback state even when one/both prepare modules are
  // disabled, preserving legacy behaviour for sparse test configs.
  return [
    "brain/temporal-expansion",
    "brain/intent-planner",
    ...explicit.filter(
      (id) =>
        id !== "brain/temporal-expansion" &&
        id !== "brain/intent-planner" &&
        id !== "brain/reranker",
    ),
    "brain/reranker",
  ];
}
