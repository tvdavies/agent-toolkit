import { selectTopK, sortByScore } from "./pipeline.js";
import type { Reranker } from "./rerank.js";
import type { RetrievalHit } from "./types.js";

export interface FinalizeRetrievalOptions {
  hits: RetrievalHit[];
  query: string;
  topK: number;
  skipReranker?: boolean;
  reranker?: Reranker;
  shouldRunReranker: boolean;
  shouldSort: boolean;
}

export interface FinalizeRetrievalResult {
  hits: RetrievalHit[];
  rerankerRan: boolean;
}

/** Apply final sorting, optional model rerank, and top-K selection. */
export async function finalizeRetrieval(
  opts: FinalizeRetrievalOptions,
): Promise<FinalizeRetrievalResult> {
  let hits = opts.hits;
  if (opts.shouldSort) sortByScore(hits);

  let rerankerRan = false;
  if (
    opts.shouldRunReranker &&
    opts.reranker !== undefined &&
    hits.length > 1 &&
    opts.skipReranker !== true
  ) {
    hits = await opts.reranker.rerank(opts.query, hits, hits.length);
    rerankerRan = true;
    for (const hit of hits) {
      if (hit.scoring) hit.scoring.rerankerRanked = true;
    }
  }

  return { hits: selectTopK(hits, opts.topK), rerankerRan };
}
