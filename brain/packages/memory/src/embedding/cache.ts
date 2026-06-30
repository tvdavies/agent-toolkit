/**
 * Persistent embedding cache backed by SQLite.
 *
 * Wraps any `Embedder` with a write-through cache keyed by
 * `(model_id, text)`. Hits skip the underlying call entirely; misses
 * call the inner embedder and back-fill the cache atomically.
 *
 * Why bother:
 *
 *   - The hot path for `brain query` is the gateway embedder
 *     round-trip (~350ms). Repeating the same query is free if
 *     we've seen it before.
 *   - Embeddings for a given (model, text) are deterministic — no
 *     "stale" concern. LRU eviction is purely a storage-budget knob.
 *   - Switching embedder models invalidates the cache naturally —
 *     the model id is part of the key, so nothing collides.
 *
 * The cache is generic: it stores everything the embedder sees,
 * including write-time chunk embeddings. Most users will never see
 * a hit on those (chunks are content-hash-deduped at write so the
 * same body never re-embeds), but they consume cache slots until
 * evicted. The default `maxEntries` (5000) is sized comfortably for
 * mixed query + chunk traffic on personal-scale brains.
 *
 * Disposal: callers must `close()` to flush the SQLite connection.
 * `openBrain` wires this into the Brain's lifecycle.
 */

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Embedder } from "./types.js";

export type EmbeddingCacheOptions = {
  /** SQLite file path. Parent directory is created if missing. */
  dbPath: string;
  /** LRU cap. Once exceeded, oldest by `last_accessed_at` are dropped. Default 5000. */
  maxEntries?: number;
};

export interface EmbeddingCache {
  get(modelId: string, text: string): Float32Array | undefined;
  set(modelId: string, text: string, embedding: Float32Array): void;
  size(): number;
  close(): void;
}

const DEFAULT_MAX_ENTRIES = 5000;

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS embeddings (
  model_id TEXT NOT NULL,
  text TEXT NOT NULL,
  dim INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  PRIMARY KEY (model_id, text)
)`;

const INDEX_SQL = `CREATE INDEX IF NOT EXISTS embeddings_lru ON embeddings(last_accessed_at)`;

function ensureDimColumn(db: Database): void {
  const rows = db.query<{ name: string }, []>("PRAGMA table_info(embeddings)").all();
  if (rows.some((r) => r.name === "dim")) return;
  // Older caches predated the dimension column. Preserve rows and infer
  // dim from blob byte length; vectors are Float32Array blobs.
  db.run("ALTER TABLE embeddings ADD COLUMN dim INTEGER NOT NULL DEFAULT 0");
  db.run("UPDATE embeddings SET dim = length(embedding) / 4 WHERE dim = 0");
}

export function createEmbeddingCache(opts: EmbeddingCacheOptions): EmbeddingCache {
  const cacheDir = dirname(opts.dbPath);
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  chmodSync(cacheDir, 0o700);
  const db = new Database(opts.dbPath, { create: true });
  chmodSync(opts.dbPath, 0o600);
  db.run(SCHEMA_SQL);
  ensureDimColumn(db);
  db.run(INDEX_SQL);

  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;

  // Monotonic stamp for LRU ordering. Date.now() at ms resolution
  // collides on bursty workloads (tests run two sets in <1ms),
  // breaking the eviction order. Initialise from the persisted max so
  // reopens still order new writes after old ones.
  const maxStmt = db.prepare<{ max_ts: number | null }, []>(
    "SELECT MAX(last_accessed_at) AS max_ts FROM embeddings",
  );
  let stampCursor = maxStmt.get()?.max_ts ?? 0;
  const nextStamp = (): number => {
    stampCursor = Math.max(stampCursor + 1, Date.now());
    return stampCursor;
  };

  const getStmt = db.prepare<{ dim: number; embedding: Uint8Array }, [string, string]>(
    "SELECT dim, embedding FROM embeddings WHERE model_id = ? AND text = ?",
  );
  const touchStmt = db.prepare<unknown, [number, string, string]>(
    "UPDATE embeddings SET last_accessed_at = ? WHERE model_id = ? AND text = ?",
  );
  const insertStmt = db.prepare<unknown, [string, string, number, Uint8Array, number]>(
    "INSERT OR REPLACE INTO embeddings (model_id, text, dim, embedding, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
  );
  const sizeStmt = db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM embeddings");
  const evictStmt = db.prepare<unknown, [number]>(
    "DELETE FROM embeddings WHERE rowid IN (SELECT rowid FROM embeddings ORDER BY last_accessed_at ASC LIMIT ?)",
  );

  return {
    get(modelId, text) {
      const row = getStmt.get(modelId, text);
      if (row === null) return undefined;
      // Touch on read so LRU reflects "last seen" not "last written."
      touchStmt.run(nextStamp(), modelId, text);
      const buf = row.embedding;
      // Copy bytes into a fresh ArrayBuffer so the returned vector
      // outlives the row's underlying storage.
      const copy = new ArrayBuffer(buf.byteLength);
      new Uint8Array(copy).set(buf);
      return new Float32Array(copy);
    },

    set(modelId, text, embedding) {
      const bytes = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
      insertStmt.run(modelId, text, embedding.length, bytes, nextStamp());
      const n = sizeStmt.get()?.n ?? 0;
      if (n > maxEntries) {
        evictStmt.run(n - maxEntries);
      }
    },

    size() {
      return sizeStmt.get()?.n ?? 0;
    },

    close() {
      db.close();
    },
  };
}

/**
 * Wrap an embedder with a persistent cache. The wrapper preserves
 * batch semantics: a single `embed([a, b, c])` call splits into
 * cached + uncached, only the missing texts hit the inner embedder,
 * and the result is reassembled in the original order.
 *
 * Misses inside a batch get cached after the inner call returns.
 */
export function withEmbeddingCache(inner: Embedder, cache: EmbeddingCache): Embedder {
  return {
    id: inner.id,
    dim: inner.dim,
    async embed(texts) {
      if (texts.length === 0) return [];
      const out: (Float32Array | undefined)[] = new Array(texts.length);
      const missIdxs: number[] = [];
      const missTexts: string[] = [];
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        if (text === undefined) continue;
        const cached = cache.get(inner.id, text);
        if (cached !== undefined && cached.length === inner.dim) {
          out[i] = cached;
        } else {
          missIdxs.push(i);
          missTexts.push(text);
        }
      }
      if (missTexts.length > 0) {
        const fresh = await inner.embed(missTexts);
        for (let j = 0; j < missTexts.length; j++) {
          const idx = missIdxs[j];
          const emb = fresh[j];
          const text = missTexts[j];
          if (idx === undefined || emb === undefined || text === undefined) continue;
          out[idx] = emb;
          cache.set(inner.id, text, emb);
        }
      }
      return out as Float32Array[];
    },
  };
}
