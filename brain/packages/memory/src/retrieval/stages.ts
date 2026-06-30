import type { RetrievalInput } from "@ai-assistant/contracts";
import { classifyIntent, type IntentClassification } from "./intent.js";
import { expandTemporal } from "./temporal-expansion.js";

export type PreparedRetrievalQuery = {
  originalQuery: string;
  effectiveQuery: string;
  input: RetrievalInput;
  temporalExpanded: boolean;
};

export type RetrievalPlan = {
  intent: IntentClassification;
  topK: number;
};

/** Stage 1: normalize/expand the incoming query without touching storage. */
export function prepareRetrievalQuery(input: RetrievalInput): PreparedRetrievalQuery {
  const expansion = expandTemporal(input.query, input.anchorDate);
  const effectiveQuery =
    expansion.resolved || expansion.expandedQuery !== expansion.originalQuery
      ? expansion.expandedQuery
      : input.query;
  return {
    originalQuery: input.query,
    effectiveQuery,
    input: effectiveQuery !== input.query ? { ...input, query: effectiveQuery } : input,
    temporalExpanded: effectiveQuery !== input.query,
  };
}

/** Stage 2: classify intent and resolve the retrieval budget. */
export function planRetrieval(
  effectiveQuery: string,
  input: RetrievalInput,
  defaultTopK: number,
  pathBoostTopK: number | undefined,
): RetrievalPlan {
  const intent = classifyIntent(effectiveQuery);
  const baseTopK = intent.topK ?? input.budget?.maxItems ?? defaultTopK;
  const topK =
    intent.pathMultipliers !== undefined && pathBoostTopK !== undefined ? pathBoostTopK : baseTopK;
  return { intent, topK };
}
