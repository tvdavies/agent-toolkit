/**
 * Embedder contract. Storage stores Float32Array vectors; retrieval needs
 * a query embedding to call vector search. Pluggable so we can swap
 * hosted Gemini, hosted OpenAI, local Ollama, etc. without touching the
 * rest of the memory pipeline.
 */
export interface Embedder {
  /** Stable identifier — used to namespace vectors when we have multiple. */
  readonly id: string;
  /** Output dimensionality. Storage's `chunks_vec` table is sized to this. */
  readonly dim: number;
  /** Embed N texts; returns a Float32Array per input in the same order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}
