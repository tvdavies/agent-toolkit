import type {
  Candidate,
  Disposable,
  Edge,
  EntityMention,
  MemoryDocument,
  MetadataPatch,
  RebuildReport,
  RepoChangeHandler,
  RepoFilter,
  TextQuery,
  VectorQuery,
} from "./types.js";

/** Authoritative document repository boundary. Implementations may be markdown, SQLite, or remote. */
export interface MemoryRepository {
  put(doc: MemoryDocument): Promise<void>;
  get(id: string): Promise<MemoryDocument | undefined>;
  list(filter?: RepoFilter): Promise<MemoryDocument[]>;
  updateMetadata(id: string, patch: MetadataPatch): Promise<void>;
  delete(id: string): Promise<void>;
  watch?(handler: RepoChangeHandler): Disposable;
}

/** Derived search index boundary. Implementations must tolerate rebuilds from the repository. */
export interface MemoryIndex {
  upsert(doc: MemoryDocument): Promise<void>;
  remove(id: string): Promise<void>;
  searchText(query: TextQuery): Promise<Candidate[]>;
  searchVector(query: VectorQuery): Promise<Candidate[]>;
  upsertEntities(id: string, entities: EntityMention[]): Promise<void>;
  upsertEdges(edges: Edge[]): Promise<void>;
  rebuildFrom(repo: MemoryRepository): Promise<RebuildReport>;
}

export interface QueueStore {
  enqueue(queue: string, payload: unknown): Promise<string>;
  dequeue(queue: string): Promise<{ id: string; payload: unknown } | undefined>;
  ack(id: string): Promise<void>;
}

export interface LockStore {
  acquire(name: string, ttlMs: number): Promise<Disposable | undefined>;
}

export interface UsageStore {
  bump(key: string, amount?: number): Promise<void>;
  get(key: string): Promise<number>;
}

export interface RetrievalLogStore {
  record(entry: Record<string, unknown>): Promise<void>;
}

export interface L0Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CacheStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Runtime stores for queues, locks, usage, short-lived memory, logs, and caches. */
export interface BrainRuntimeStore {
  queue: QueueStore;
  locks: LockStore;
  usage: UsageStore;
  retrievalLog: RetrievalLogStore;
  l0: L0Store;
  cache: CacheStore;
}

/** Per-module persistent state facade. */
export interface ModuleStateStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}
