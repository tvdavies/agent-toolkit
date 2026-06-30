import type { RetrievalInput } from "@ai-assistant/contracts";
import type { Embedder } from "../embedding/index.js";
import type { ExtensionCandidateGenerator, ExtensionRanker, ExtensionSelector } from "../memory.js";
import type { Storage } from "../storage/sqlite.js";
import type { EntityIndex } from "./entity.js";
import type { QueryExpander } from "./expander.js";
import type { FallbackQueryRewriter } from "./fallback-rewrite.js";
import type { Reranker } from "./rerank.js";

export interface BuiltInRecallServices {
  input: RetrievalInput;
  storages: readonly Storage[];
  embedders: readonly Embedder[];
  embedderWeights: readonly number[];
  defaultTopK: number;
  candidateK: number;
  entityIndex: EntityIndex;
  queryExpander?: QueryExpander;
  fallbackQueryRewriter?: FallbackQueryRewriter;
  pathBoostTopK?: number;
  reranker?: Reranker;
  extensionCandidateGenerators: readonly ExtensionCandidateGenerator[];
  extensionRankers: readonly ExtensionRanker[];
  extensionSelectors: readonly ExtensionSelector[];
}
