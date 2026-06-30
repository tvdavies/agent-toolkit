import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as sqliteVec from "sqlite-vec";
import type { Chunk, SearchHit } from "./types.js";

/** sha-256 hex of a body. Used by the file watcher to skip no-op edits. */
export function hashContent(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export type SqliteStorageOptions = {
  /** Filesystem path or `:memory:` (default). */
  dbPath?: string;
  /**
   * Vector dimensionality. Chunks_vec virtual table is sized to this at
   * creation time; changing it later requires a manual rebuild. Defaults
   * to 768 (Gemini Embedding 001).
   */
  vectorDim?: number;
  /**
   * How long SQLite should wait for another process to release a lock before
   * throwing SQLITE_BUSY. The brain extension can run `brain remember` while
   * the daemon/query processes have the same database open, so the default
   * must be non-zero.
   */
  busyTimeoutMs?: number;
};

export type Edge = {
  fromChunkId: string;
  /** Either toChunkId OR toEntity is set, never both. */
  toChunkId?: string;
  toEntity?: string;
  linkType: string;
  context?: string;
  linkSource?: string;
  originChunkId?: string;
};

export interface Storage {
  readonly vectorDim: number;
  upsertChunk(chunk: Chunk): void;
  upsertChunks(chunks: readonly Chunk[]): void;
  deleteChunk(id: string): void;
  getChunk(id: string): Chunk | undefined;
  searchBM25(query: string, limit: number): SearchHit[];
  searchVector(embedding: Float32Array, limit: number): SearchHit[];
  /** Number of chunks indexed (live; archived chunks not counted). */
  size(): number;
  /** Insert (id-deduped) edges into the graph layer. */
  upsertEdges(edges: readonly Edge[]): void;
  /** All outbound edges from a chunk. */
  outboundEdges(fromChunkId: string): Edge[];
  /** Inbound edge counts by chunk id (chunk-to-chunk wikilinks only). */
  inboundCounts(toChunkIds: readonly string[]): Map<string, number>;
  /**
   * Soft-delete a chunk: stamp deleted_at, set
   * archive_expires_at = now + recoveryWindowMs. Excluded from
   * search until restored or purged.
   */
  archiveChunk(id: string, recoveryWindowMs?: number): void;
  /** Reverse a soft-delete. No-op if not archived. */
  restoreChunk(id: string): void;
  /** Permanently drop chunks past archive_expires_at. Returns count. */
  purgeExpired(now?: number): number;
  /**
   * Iterate every live chunk. Returns id + path + type + content;
   * embedding is fetched separately when needed. Used by the
   * daemon's link-fix and dedup phases.
   */
  listLiveChunks(): Chunk[];
  /** Lookup a chunk by its absolute file path. Used by the file watcher. */
  getChunkByPath(filePath: string): Chunk | undefined;
  /**
   * Lookup the id of a live chunk by its content hash. Used by Memory's
   * write-time dedup to skip rewriting a chunk whose body already exists
   * (`brain add "..."` twice → no second chunk). Archived chunks are
   * excluded so a soft-deleted twin doesn't block a re-record.
   */
  findChunkIdByContentHash(hash: string): string | undefined;
  /**
   * Read the embedding stored for a chunk, when present. Used by the
   * daemon's dedup phase to compute cross-chunk cosine similarity.
   */
  getEmbedding(chunkId: string): Float32Array | undefined;
  /**
   * Replace all edges originating from `fromChunkId`. Used by the
   * daemon's link-fix phase to reconcile a chunk's edges against
   * its current body without leaving stale rows behind.
   */
  replaceOutboundEdges(fromChunkId: string, edges: readonly Edge[]): void;
  /** Daemon state I/O. */
  getDaemonState(phase: string): DaemonState | undefined;
  setDaemonState(state: DaemonState): void;
  /** Persistent entity index. */
  upsertChunkEntities(chunkId: string, entities: readonly string[]): void;
  findChunksByEntities(queryEntities: readonly string[]): string[];
  entityPopularityFor(chunkId: string): number;
  /** Persistent slug resolver. */
  upsertSlug(scope: string, slug: string, chunkId: string): void;
  resolveSlug(scope: string, slug: string): string | undefined;
  /** Mark an existing chunk as superseded by a newer chunk. */
  markSuperseded(idOrPath: string, supersededBy: string): void;
  /** Bump retrieval counters for chunk ids surfaced by this query. */
  bumpRetrievalCounters(ids: readonly string[], at?: number): void;
  /** Bump injection counters for chunk ids the actor saw. */
  bumpInjectionCounters(ids: readonly string[], at?: number): void;
  /** Bump citation counters for chunk ids the actor referenced in its answer. */
  bumpCitationCounters(ids: readonly string[], at?: number): void;
  /** Read usage stats for a chunk. */
  getUsage(chunkId: string): UsageStats | undefined;
  close(): Promise<void>;
}

export type UsageStats = {
  retrievalCount: number;
  lastRetrievedAt?: number;
  injectionCount: number;
  lastInjectedAt?: number;
  citationCount: number;
  lastCitedAt?: number;
};

export type DaemonState = {
  phase: string;
  lastRunAt?: number;
  lastStatus?: string;
  lastError?: string;
  inProgressRunId?: string;
};

const DEFAULT_VECTOR_DIM = 768;

const SCHEMA = (vectorDim: number) => `
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  type TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  metadata_json TEXT,
  content_hash TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  -- Usage counters (Round 3) — bumped at retrieve / inject / cite
  -- time so the daemon's stale heuristic can see "never retrieved"
  -- vs "actively used". last_*_at lets a future ranker decay
  -- chunks that haven't fired in a while.
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at INTEGER,
  injection_count INTEGER NOT NULL DEFAULT 0,
  last_injected_at INTEGER,
  citation_count INTEGER NOT NULL DEFAULT 0,
  last_cited_at INTEGER,
  -- Soft-delete + recovery window (port of GBrain). NULL when live;
  -- INTEGER ms-since-epoch when archived. Search filters by
  -- deleted_at IS NULL by default; the daemon's purge sweep
  -- consults archive_expires_at to decide what is safe to drop.
  deleted_at INTEGER,
  archive_expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS chunks_path_idx ON chunks(path);
CREATE INDEX IF NOT EXISTS chunks_type_idx ON chunks(type);
CREATE INDEX IF NOT EXISTS chunks_deleted_at_idx
  ON chunks(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
  embedding float[${vectorDim}]
);

-- Graph layer (port of GBrain's typed-edge model). Stores edges
-- emitted by the link inferrer at write time. Edges target either
-- another chunk (chunk-to-chunk wikilinks) or a free-text entity
-- string (chunk-to-entity references); exactly one of to_chunk_id /
-- to_entity is non-null per row.
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  from_chunk_id TEXT NOT NULL,
  to_chunk_id TEXT,
  to_entity TEXT,
  link_type TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  link_source TEXT NOT NULL DEFAULT 'markdown',
  origin_chunk_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((to_chunk_id IS NOT NULL) OR (to_entity IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS edges_from_idx ON edges(from_chunk_id);
CREATE INDEX IF NOT EXISTS edges_to_chunk_idx ON edges(to_chunk_id);
CREATE INDEX IF NOT EXISTS edges_to_entity_idx ON edges(to_entity);
CREATE INDEX IF NOT EXISTS edges_type_idx ON edges(link_type);
CREATE UNIQUE INDEX IF NOT EXISTS edges_dedup_idx
  ON edges(from_chunk_id, IFNULL(to_chunk_id, ''), IFNULL(to_entity, ''), link_type, link_source);

-- Persistent entity / slug indexes. These mirror the in-memory
-- EntityIndex and SlugResolver so recall survives process restarts.
CREATE TABLE IF NOT EXISTS chunk_entities (
  chunk_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, entity)
);
CREATE INDEX IF NOT EXISTS chunk_entities_entity_idx ON chunk_entities(entity);

CREATE TABLE IF NOT EXISTS slugs (
  scope TEXT NOT NULL,
  slug TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, slug)
);
CREATE INDEX IF NOT EXISTS slugs_chunk_idx ON slugs(chunk_id);

-- Daemon state. One row per (phase) tracks last_run_at +
-- last_status; the lock holder writes its run id while a phase is
-- in progress so concurrent runs see "in_progress" and back off.
CREATE TABLE IF NOT EXISTS daemon_state (
  phase TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_status TEXT,
  last_error TEXT,
  in_progress_run_id TEXT
);
`;

/**
 * SQLite-backed storage with FTS5 BM25 + sqlite-vec vector index.
 *
 * Chunk linkage: `chunks_vec.rowid` mirrors `chunks.rowid`. We resolve
 * the rowid via `SELECT rowid FROM chunks WHERE id = ?` after upsert
 * (chunks.id is TEXT, sqlite-vec's table needs INTEGER rowid).
 *
 * Vectors are optional per chunk; chunks without `embedding` are only
 * searchable via BM25.
 */
export function createSqliteStorage(opts: SqliteStorageOptions = {}): Storage {
  const vectorDim = opts.vectorDim ?? DEFAULT_VECTOR_DIM;
  const busyTimeoutMs = Math.max(0, Math.trunc(opts.busyTimeoutMs ?? 10_000));
  const db = new Database(opts.dbPath ?? ":memory:");
  db.loadExtension(sqliteVec.getLoadablePath());
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  db.exec(SCHEMA(vectorDim));

  const upsertStmt = db.prepare<
    unknown,
    [string, string, string, number, string, string | null, string, number]
  >(
    `INSERT INTO chunks(id, path, type, ordinal, content, metadata_json, content_hash, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         path          = excluded.path,
         type          = excluded.type,
         ordinal       = excluded.ordinal,
         content       = excluded.content,
         metadata_json = excluded.metadata_json,
         content_hash  = excluded.content_hash`,
  );
  const rowidStmt = db.prepare<{ rowid: number }, [string]>(
    "SELECT rowid FROM chunks WHERE id = ?",
  );
  const ftsDeleteStmt = db.prepare<unknown, [string]>("DELETE FROM chunks_fts WHERE chunk_id = ?");
  const ftsInsertStmt = db.prepare<unknown, [string, string]>(
    "INSERT INTO chunks_fts(chunk_id, content) VALUES(?, ?)",
  );
  const vecDeleteStmt = db.prepare<unknown, [number]>("DELETE FROM chunks_vec WHERE rowid = ?");
  const vecInsertStmt = db.prepare<unknown, [number, Uint8Array]>(
    "INSERT INTO chunks_vec(rowid, embedding) VALUES(?, ?)",
  );
  const deleteChunkStmt = db.prepare<unknown, [string]>("DELETE FROM chunks WHERE id = ?");
  const getChunkStmt = db.prepare<RawChunkRow, [string]>(
    "SELECT id, path, type, ordinal, content, metadata_json, content_hash FROM chunks WHERE id = ? AND deleted_at IS NULL",
  );
  const getChunkByPathStmt = db.prepare<RawChunkRow, [string]>(
    "SELECT id, path, type, ordinal, content, metadata_json, content_hash FROM chunks WHERE path = ? AND deleted_at IS NULL",
  );
  const findIdByHashStmt = db.prepare<{ id: string }, [string]>(
    "SELECT id FROM chunks WHERE content_hash = ? AND deleted_at IS NULL LIMIT 1",
  );
  const sizeStmt = db.prepare<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM chunks WHERE deleted_at IS NULL",
  );
  const recallableWhere = `c.type != 'episodic'`;
  const bm25Stmt = db.prepare<RawSearchRow, [string, number]>(
    `SELECT c.id, c.path, c.type, c.ordinal, c.content, c.metadata_json, c.content_hash, bm25(chunks_fts) AS score
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.chunk_id
      WHERE chunks_fts MATCH ?
        AND c.deleted_at IS NULL
        AND ${recallableWhere}
      ORDER BY score
      LIMIT ?`,
  );
  const vecStmt = db.prepare<RawVectorRow, [Uint8Array, number]>(
    `SELECT c.id, c.path, c.type, c.ordinal, c.content, c.metadata_json, c.content_hash, v.distance
       FROM chunks_vec v
       JOIN chunks c ON c.rowid = v.rowid
      WHERE v.embedding MATCH ?
        AND k = ?
        AND c.deleted_at IS NULL
        AND ${recallableWhere}
      ORDER BY v.distance`,
  );
  const archiveStmt = db.prepare<unknown, [number, number, string]>(
    "UPDATE chunks SET deleted_at = ?, archive_expires_at = ? WHERE id = ? AND deleted_at IS NULL",
  );
  const restoreStmt = db.prepare<unknown, [string]>(
    "UPDATE chunks SET deleted_at = NULL, archive_expires_at = NULL WHERE id = ?",
  );
  const purgeListStmt = db.prepare<{ id: string }, [number]>(
    "SELECT id FROM chunks WHERE deleted_at IS NOT NULL AND archive_expires_at IS NOT NULL AND archive_expires_at <= ?",
  );
  const listLiveStmt = db.prepare<RawChunkRow, []>(
    "SELECT id, path, type, ordinal, content, metadata_json, content_hash FROM chunks WHERE deleted_at IS NULL",
  );
  const getEmbeddingStmt = db.prepare<{ embedding: Uint8Array }, [string]>(
    `SELECT v.embedding AS embedding
       FROM chunks_vec v JOIN chunks c ON c.rowid = v.rowid
      WHERE c.id = ?`,
  );
  const deleteOutboundEdgesStmt = db.prepare<unknown, [string]>(
    "DELETE FROM edges WHERE from_chunk_id = ?",
  );
  const daemonGetStmt = db.prepare<RawDaemonRow, [string]>(
    `SELECT phase, last_run_at, last_status, last_error, in_progress_run_id
       FROM daemon_state WHERE phase = ?`,
  );
  const daemonSetStmt = db.prepare<
    unknown,
    [string, number | null, string | null, string | null, string | null]
  >(
    `INSERT INTO daemon_state(phase, last_run_at, last_status, last_error, in_progress_run_id)
       VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(phase) DO UPDATE SET
       last_run_at         = excluded.last_run_at,
       last_status         = excluded.last_status,
       last_error          = excluded.last_error,
       in_progress_run_id  = excluded.in_progress_run_id`,
  );
  const bumpRetrievalStmt = db.prepare<unknown, [number, string]>(
    "UPDATE chunks SET retrieval_count = retrieval_count + 1, last_retrieved_at = ? WHERE id = ?",
  );
  const bumpInjectionStmt = db.prepare<unknown, [number, string]>(
    "UPDATE chunks SET injection_count = injection_count + 1, last_injected_at = ? WHERE id = ?",
  );
  const bumpCitationStmt = db.prepare<unknown, [number, string]>(
    "UPDATE chunks SET citation_count = citation_count + 1, last_cited_at = ? WHERE id = ?",
  );
  const getUsageStmt = db.prepare<RawUsageRow, [string]>(
    `SELECT retrieval_count, last_retrieved_at, injection_count, last_injected_at,
            citation_count, last_cited_at
       FROM chunks WHERE id = ?`,
  );
  const deleteChunkEntitiesStmt = db.prepare<unknown, [string]>(
    "DELETE FROM chunk_entities WHERE chunk_id = ?",
  );
  const insertChunkEntityStmt = db.prepare<unknown, [string, string, number]>(
    "INSERT OR IGNORE INTO chunk_entities(chunk_id, entity, created_at) VALUES(?, ?, ?)",
  );
  const listChunkEntitiesStmt = db.prepare<{ entity: string }, [string]>(
    "SELECT entity FROM chunk_entities WHERE chunk_id = ?",
  );
  const listAllChunkEntitiesStmt = db.prepare<{ entity: string; chunk_id: string }, []>(
    `SELECT ce.entity, ce.chunk_id
       FROM chunk_entities ce JOIN chunks c ON c.id = ce.chunk_id
      WHERE c.deleted_at IS NULL`,
  );
  const upsertSlugStmt = db.prepare<unknown, [string, string, string, number]>(
    `INSERT INTO slugs(scope, slug, chunk_id, updated_at) VALUES(?, ?, ?, ?)
     ON CONFLICT(scope, slug) DO UPDATE SET chunk_id = excluded.chunk_id, updated_at = excluded.updated_at`,
  );
  const resolveSlugStmt = db.prepare<{ chunk_id: string }, [string, string]>(
    `SELECT s.chunk_id
       FROM slugs s JOIN chunks c ON c.id = s.chunk_id
      WHERE s.scope = ? AND s.slug = ? AND c.deleted_at IS NULL`,
  );
  const getChunkByIdOrPathStmt = db.prepare<RawChunkRow, [string, string]>(
    `SELECT id, path, type, ordinal, content, metadata_json, content_hash
       FROM chunks WHERE (id = ? OR path = ?) AND deleted_at IS NULL LIMIT 1`,
  );
  const updateMetadataStmt = db.prepare<unknown, [string, string]>(
    "UPDATE chunks SET metadata_json = ? WHERE id = ?",
  );

  const edgeUpsertStmt = db.prepare<
    unknown,
    [string, string | null, string | null, string, string, string, string | null, number]
  >(
    `INSERT INTO edges(
       from_chunk_id, to_chunk_id, to_entity, link_type,
       context, link_source, origin_chunk_id, created_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(from_chunk_id, IFNULL(to_chunk_id, ''), IFNULL(to_entity, ''), link_type, link_source)
     DO UPDATE SET context = excluded.context`,
  );
  const edgeOutboundStmt = db.prepare<RawEdgeRow, [string]>(
    `SELECT from_chunk_id, to_chunk_id, to_entity, link_type, context, link_source, origin_chunk_id
       FROM edges WHERE from_chunk_id = ?`,
  );

  function f32ToBytes(f: Float32Array): Uint8Array {
    return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  }

  function upsertChunkInner(chunk: Chunk): void {
    const meta = chunk.metadata === undefined ? null : JSON.stringify(chunk.metadata);
    const hash = chunk.contentHash ?? hashContent(chunk.content);
    upsertStmt.run(
      chunk.id,
      chunk.path,
      chunk.type,
      chunk.ordinal,
      chunk.content,
      meta,
      hash,
      Date.now(),
    );
    const row = rowidStmt.get(chunk.id);
    if (row === null) throw new Error(`chunks row missing after upsert: ${chunk.id}`);
    const rowid = row.rowid;
    ftsDeleteStmt.run(chunk.id);
    ftsInsertStmt.run(chunk.id, chunk.content);
    vecDeleteStmt.run(rowid);
    if (chunk.embedding !== undefined) {
      if (chunk.embedding.length !== vectorDim) {
        throw new Error(
          `embedding dim mismatch: got ${chunk.embedding.length}, expected ${vectorDim}`,
        );
      }
      vecInsertStmt.run(rowid, f32ToBytes(chunk.embedding));
    }
  }

  return {
    vectorDim,
    upsertChunk(chunk) {
      db.transaction(() => upsertChunkInner(chunk))();
    },
    upsertChunks(chunks) {
      if (chunks.length === 0) return;
      db.transaction(() => {
        for (const c of chunks) upsertChunkInner(c);
      })();
    },
    deleteChunk(id) {
      db.transaction(() => {
        const row = rowidStmt.get(id);
        if (row !== null) vecDeleteStmt.run(row.rowid);
        ftsDeleteStmt.run(id);
        deleteChunkStmt.run(id);
      })();
    },
    getChunk(id) {
      const row = getChunkStmt.get(id);
      return row === null ? undefined : hydrate(row);
    },
    size() {
      const row = sizeStmt.get();
      return row?.n ?? 0;
    },
    searchBM25(query, limit) {
      const expr = compileToFts5Or(query);
      if (expr === "") return [];
      const rows = bm25Stmt.all(expr, limit);
      return rows.map((r) => ({ chunk: hydrate(r), score: -r.score }));
    },
    searchVector(embedding, limit) {
      if (embedding.length !== vectorDim) {
        throw new Error(
          `query embedding dim mismatch: got ${embedding.length}, expected ${vectorDim}`,
        );
      }
      const rows = vecStmt.all(f32ToBytes(embedding), limit);
      // Convert L2 distance to cosine-similarity-like score in [0, 1] under
      // the assumption embeddings are unit-normalised. Distance 0 → score 1;
      // distance √2 → score 0. Higher = better.
      return rows.map((r) => ({
        chunk: hydrate(r),
        score: Math.max(0, 1 - r.distance / Math.sqrt(2)),
      }));
    },
    upsertEdges(edges) {
      if (edges.length === 0) return;
      const now = Date.now();
      db.transaction(() => {
        for (const e of edges) {
          edgeUpsertStmt.run(
            e.fromChunkId,
            e.toChunkId ?? null,
            e.toEntity ?? null,
            e.linkType,
            e.context ?? "",
            e.linkSource ?? "markdown",
            e.originChunkId ?? null,
            now,
          );
        }
      })();
    },
    archiveChunk(id, recoveryWindowMs = 30 * 24 * 60 * 60 * 1000) {
      const now = Date.now();
      archiveStmt.run(now, now + recoveryWindowMs, id);
    },
    restoreChunk(id) {
      restoreStmt.run(id);
    },
    purgeExpired(now = Date.now()) {
      const ids = purgeListStmt.all(now).map((r) => r.id);
      if (ids.length === 0) return 0;
      db.transaction(() => {
        for (const id of ids) {
          const row = rowidStmt.get(id);
          if (row !== null) vecDeleteStmt.run(row.rowid);
          ftsDeleteStmt.run(id);
          deleteChunkStmt.run(id);
        }
      })();
      return ids.length;
    },
    listLiveChunks() {
      return listLiveStmt.all().map(hydrate);
    },
    getChunkByPath(filePath) {
      const row = getChunkByPathStmt.get(filePath);
      return row === null ? undefined : hydrate(row);
    },
    findChunkIdByContentHash(hash) {
      const row = findIdByHashStmt.get(hash);
      return row === null ? undefined : row.id;
    },
    getEmbedding(chunkId) {
      const row = getEmbeddingStmt.get(chunkId);
      if (row === null) return undefined;
      const buf = row.embedding;
      return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    },
    replaceOutboundEdges(fromChunkId, edges) {
      db.transaction(() => {
        deleteOutboundEdgesStmt.run(fromChunkId);
        const now = Date.now();
        for (const e of edges) {
          edgeUpsertStmt.run(
            e.fromChunkId,
            e.toChunkId ?? null,
            e.toEntity ?? null,
            e.linkType,
            e.context ?? "",
            e.linkSource ?? "markdown",
            e.originChunkId ?? null,
            now,
          );
        }
      })();
    },
    getDaemonState(phase) {
      const row = daemonGetStmt.get(phase);
      if (row === null) return undefined;
      return {
        phase: row.phase,
        ...(row.last_run_at !== null ? { lastRunAt: row.last_run_at } : {}),
        ...(row.last_status !== null ? { lastStatus: row.last_status } : {}),
        ...(row.last_error !== null ? { lastError: row.last_error } : {}),
        ...(row.in_progress_run_id !== null ? { inProgressRunId: row.in_progress_run_id } : {}),
      };
    },
    setDaemonState(state) {
      daemonSetStmt.run(
        state.phase,
        state.lastRunAt ?? null,
        state.lastStatus ?? null,
        state.lastError ?? null,
        state.inProgressRunId ?? null,
      );
    },
    bumpRetrievalCounters(ids, at = Date.now()) {
      if (ids.length === 0) return;
      db.transaction(() => {
        for (const id of ids) bumpRetrievalStmt.run(at, id);
      })();
    },
    bumpInjectionCounters(ids, at = Date.now()) {
      if (ids.length === 0) return;
      db.transaction(() => {
        for (const id of ids) bumpInjectionStmt.run(at, id);
      })();
    },
    bumpCitationCounters(ids, at = Date.now()) {
      if (ids.length === 0) return;
      db.transaction(() => {
        for (const id of ids) bumpCitationStmt.run(at, id);
      })();
    },
    upsertChunkEntities(chunkId, entities) {
      db.transaction(() => {
        deleteChunkEntitiesStmt.run(chunkId);
        const now = Date.now();
        for (const e of entities) {
          const key = e.trim().toLowerCase();
          if (key !== "") insertChunkEntityStmt.run(chunkId, key, now);
        }
      })();
    },
    findChunksByEntities(queryEntities) {
      const qs = queryEntities.map((e) => e.trim().toLowerCase()).filter((e) => e !== "");
      if (qs.length === 0) return [];
      const out = new Set<string>();
      for (const row of listAllChunkEntitiesStmt.all()) {
        for (const q of qs) {
          if (row.entity.includes(q) || q.startsWith(row.entity)) {
            out.add(row.chunk_id);
            break;
          }
        }
      }
      return [...out];
    },
    entityPopularityFor(chunkId) {
      const entities = listChunkEntitiesStmt.all(chunkId).map((r) => r.entity);
      if (entities.length === 0) return 0;
      const all = listAllChunkEntitiesStmt.all();
      let max = 0;
      for (const entity of entities) {
        let count = 0;
        for (const row of all) if (row.entity === entity && row.chunk_id !== chunkId) count++;
        if (count > max) max = count;
      }
      return max;
    },
    upsertSlug(scope, slug, chunkId) {
      upsertSlugStmt.run(scope, slug, chunkId, Date.now());
    },
    resolveSlug(scope, slug) {
      const row = resolveSlugStmt.get(scope, slug);
      return row === null ? undefined : row.chunk_id;
    },
    markSuperseded(idOrPath, supersededBy) {
      const row = getChunkByIdOrPathStmt.get(idOrPath, idOrPath);
      if (row === null) return;
      const metadata =
        row.metadata_json === null
          ? {}
          : (JSON.parse(row.metadata_json) as Record<string, unknown>);
      metadata.status = "superseded";
      metadata.supersededBy = supersededBy;
      updateMetadataStmt.run(JSON.stringify(metadata), row.id);
    },
    getUsage(chunkId) {
      const row = getUsageStmt.get(chunkId);
      if (row === null) return undefined;
      return {
        retrievalCount: row.retrieval_count,
        ...(row.last_retrieved_at !== null ? { lastRetrievedAt: row.last_retrieved_at } : {}),
        injectionCount: row.injection_count,
        ...(row.last_injected_at !== null ? { lastInjectedAt: row.last_injected_at } : {}),
        citationCount: row.citation_count,
        ...(row.last_cited_at !== null ? { lastCitedAt: row.last_cited_at } : {}),
      };
    },
    outboundEdges(fromChunkId) {
      return edgeOutboundStmt.all(fromChunkId).map(hydrateEdge);
    },
    inboundCounts(toChunkIds) {
      const counts = new Map<string, number>();
      if (toChunkIds.length === 0) return counts;
      const placeholders = toChunkIds.map(() => "?").join(",");
      const rows = db
        .prepare<{ to_chunk_id: string; n: number }, string[]>(
          `SELECT to_chunk_id, COUNT(*) AS n
             FROM edges
            WHERE to_chunk_id IN (${placeholders})
            GROUP BY to_chunk_id`,
        )
        .all(...toChunkIds);
      for (const r of rows) counts.set(r.to_chunk_id, r.n);
      return counts;
    },
    async close() {
      db.close();
    },
  };
}

type RawEdgeRow = {
  from_chunk_id: string;
  to_chunk_id: string | null;
  to_entity: string | null;
  link_type: string;
  context: string;
  link_source: string;
  origin_chunk_id: string | null;
};

type RawDaemonRow = {
  phase: string;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  in_progress_run_id: string | null;
};

type RawUsageRow = {
  retrieval_count: number;
  last_retrieved_at: number | null;
  injection_count: number;
  last_injected_at: number | null;
  citation_count: number;
  last_cited_at: number | null;
};

function hydrateEdge(row: RawEdgeRow): Edge {
  return {
    fromChunkId: row.from_chunk_id,
    ...(row.to_chunk_id !== null ? { toChunkId: row.to_chunk_id } : {}),
    ...(row.to_entity !== null ? { toEntity: row.to_entity } : {}),
    linkType: row.link_type,
    context: row.context,
    linkSource: row.link_source,
    ...(row.origin_chunk_id !== null ? { originChunkId: row.origin_chunk_id } : {}),
  };
}

type RawChunkRow = {
  id: string;
  path: string;
  type: string;
  ordinal: number;
  content: string;
  metadata_json: string | null;
  content_hash: string | null;
};

type RawSearchRow = RawChunkRow & { score: number };
type RawVectorRow = RawChunkRow & { distance: number };

function hydrate(row: RawChunkRow): Chunk {
  const metadata =
    row.metadata_json === null
      ? undefined
      : (JSON.parse(row.metadata_json) as Record<string, unknown>);
  return {
    id: row.id,
    path: row.path,
    type: row.type as Chunk["type"],
    ordinal: row.ordinal,
    content: row.content,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(row.content_hash !== null ? { contentHash: row.content_hash } : {}),
  };
}

/**
 * Tokenise a user query into an FTS5 MATCH expression with OR semantics.
 * Returns empty string when the query has no usable tokens.
 */
export function compileToFts5Or(query: string): string {
  const tokens = sanitiseFts5Query(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  if (tokens.length === 1) return `"${tokens[0]}"`;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Strip FTS5 metacharacters so user queries don't trigger column-scoped
 * lookups, prefix matches, or syntax errors. Punctuation and symbols are
 * replaced with whitespace and the result is trimmed.
 */
export function sanitiseFts5Query(query: string): string {
  return query
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
