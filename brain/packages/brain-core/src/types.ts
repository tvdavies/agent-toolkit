/** Role played by a persisted store. Source-of-truth stores require migrations; derived and cache stores are rebuildable. */
export type StoreRole = "source-of-truth" | "derived" | "runtime" | "cache";

/** Declared privilege needed by a module or adapter. Used for validation and trust prompts. */
export type Capability =
  | "read-repository"
  | "write-repository"
  | "read-index"
  | "write-index"
  | "network"
  | "model-call"
  | "embedding-provider"
  | "storage-adapter"
  | "migration"
  | "shell";

/** Small disposable contract returned by long-lived subscriptions and watchers. */
export interface Disposable {
  dispose(): void | Promise<void>;
}

/** Provenance for a document or mutation. Every core-written mutation should record this. */
export interface Provenance {
  source: string;
  module?: string;
  createdAt: string;
  updatedAt?: string;
}

/** Canonical memory document independent of the repository implementation. */
export interface MemoryDocument {
  id: string;
  type: string;
  body: string;
  metadata: Record<string, unknown>;
  provenance: Provenance;
  validity?: {
    validFrom?: string;
    validTo?: string;
    supersedes?: string[];
    supersededBy?: string[];
  };
}

export type MetadataPatch = Record<string, unknown>;

export interface RepoFilter {
  ids?: string[];
  types?: string[];
  metadata?: Record<string, unknown>;
}

export type RepoChangeKind = "put" | "metadata" | "delete";

export interface RepoChange {
  kind: RepoChangeKind;
  id: string;
  document?: MemoryDocument;
}

export type RepoChangeHandler = (change: RepoChange) => void | Promise<void>;

export interface TextQuery {
  query: string;
  limit?: number;
  types?: string[];
}

export interface VectorQuery {
  indexId: string;
  vector: Float32Array;
  limit?: number;
  types?: string[];
}

export interface Candidate {
  id: string;
  score: number;
  document?: MemoryDocument;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface EntityMention {
  entityId: string;
  label: string;
  kind?: string;
  span?: { start: number; end: number };
  metadata?: Record<string, unknown>;
}

export interface Edge {
  from: string;
  to: string;
  kind: string;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface RebuildReport {
  documentsRead: number;
  documentsIndexed: number;
  errors: Array<{ id?: string; message: string }>;
}

export type VectorMetric = "cosine" | "l2" | "dot";

/** Embedding model exposed by a module or adapter. */
export interface EmbeddingModel {
  id: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Named vector index definition. Changing incompatible fields requires rebuild/drop semantics. */
export interface VectorIndexSpec {
  id: string;
  modelId: string;
  dim: number;
  metric: VectorMetric;
  appliesTo: string[];
  contentTemplate: string;
}
