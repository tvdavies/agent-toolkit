export interface FallbackQueryRewriter {
  rewrite(query: string): Promise<string[]>;
}

export function shouldFallbackRewrite(args: {
  bm25Hits: number;
  vectorHits: number;
  entityHits: number;
}): boolean {
  return args.bm25Hits === 0 && args.vectorHits === 0 && args.entityHits === 0;
}

/** Cheap deterministic fallback used when no LLM rewriter is configured. */
export const heuristicFallbackRewriter: FallbackQueryRewriter = {
  async rewrite(query) {
    const cleaned = query
      .replace(
        /\b(?:what|when|where|who|why|how|did|does|do|was|were|is|are|can|could|would|should|please|remember|tell me|about)\b/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
    return cleaned !== "" && cleaned !== query ? [cleaned] : [];
  },
};
