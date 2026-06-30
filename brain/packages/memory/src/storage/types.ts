/**
 * Storage-layer types. The Memory class composes storage + retrieval +
 * extraction; storage is just "put a chunk by id, get chunks back by
 * BM25 / vector / id".
 *
 * Each chunk corresponds to a markdown file on disk under
 * `<root>/<scope>/<type>/<slug>.md`. Storage is a derived index
 * over those files: it caches body text for FTS5 / embedding lookups
 * but the canonical content lives on disk and SQLite is rebuildable
 * from it. The `path` field on a Chunk is the absolute path to that
 * source file.
 */

import type { MemoryType } from "./markdown-store.js";

export type Chunk = {
  /** Stable id. Caller-supplied so updates are deterministic. */
  id: string;
  /** Absolute path to the markdown file on disk (source of truth). */
  path: string;
  /**
   * Memory category — drives intent-time multipliers and groups files
   * into `<type>/` directories on disk. See `MEMORY_TYPES`.
   */
  type: MemoryType;
  /** Ordinal within the flush; preserved for stable in-flush ordering. */
  ordinal: number;
  /** Indexed body text (mirror of the file body, kept here for fast lookup). */
  content: string;
  /** Free-form metadata. JSON-serialised. */
  metadata?: Record<string, unknown>;
  /**
   * Optional dense embedding. When present, the storage layer indexes
   * it into the vector table; when absent, the chunk is BM25-only.
   * Length must match `Storage.vectorDim`.
   */
  embedding?: Float32Array;
  /**
   * Content hash (sha-256 of the markdown body). Surfaced for the
   * file watcher: if a notification fires but the body's hash hasn't
   * changed, we skip the re-index round-trip.
   */
  contentHash?: string;
};

export type SearchHit = {
  chunk: Chunk;
  /**
   * "Higher is better" score. For BM25, we negate SQLite's bm25() so the
   * direction matches. For vector, we convert L2 distance to a [0, 1]
   * cosine-like scale.
   */
  score: number;
};
