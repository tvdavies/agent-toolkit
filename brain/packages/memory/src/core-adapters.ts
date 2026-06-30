import { writeFile } from "node:fs/promises";
import type {
  Candidate,
  Edge as CoreEdge,
  EntityMention,
  MemoryDocument,
  MemoryIndex,
  MemoryRepository,
  MetadataPatch,
  RebuildReport,
  RepoFilter,
  TextQuery,
  VectorQuery,
} from "@ai-assistant/brain-core";
import { type Frontmatter, serialise } from "./storage/frontmatter.js";
import type { MarkdownStore, MemoryType } from "./storage/markdown-store.js";
import type { Edge, Storage } from "./storage/sqlite.js";
import type { Chunk } from "./storage/types.js";

export interface MarkdownRepositoryOptions {
  store: MarkdownStore;
  scope: string;
}

/** Markdown-backed implementation of the core MemoryRepository contract. */
export class MarkdownMemoryRepository implements MemoryRepository {
  constructor(private readonly options: MarkdownRepositoryOptions) {}

  async put(doc: MemoryDocument): Promise<void> {
    await this.options.store.write({
      scope: this.options.scope,
      type: coerceMemoryType(doc.type),
      body: doc.body,
      frontmatter: documentToFrontmatter(doc),
    });
  }

  async get(id: string): Promise<MemoryDocument | undefined> {
    for (const path of await this.listPaths()) {
      const read = await this.options.store.read(path);
      if (read.frontmatter.id === id) return readToDocument(read.body, read.frontmatter, read.type);
    }
    return undefined;
  }

  async list(filter: RepoFilter = {}): Promise<MemoryDocument[]> {
    const docs: MemoryDocument[] = [];
    for (const path of await this.listPaths(filter.types)) {
      const read = await this.options.store.read(path);
      const doc = readToDocument(read.body, read.frontmatter, read.type);
      if (filter.ids !== undefined && !filter.ids.includes(doc.id)) continue;
      docs.push(doc);
    }
    return docs;
  }

  async updateMetadata(id: string, patch: MetadataPatch): Promise<void> {
    for (const path of await this.listPaths()) {
      const read = await this.options.store.read(path);
      if (read.frontmatter.id !== id) continue;
      const next = { ...read.frontmatter, ...metadataPatchToFrontmatter(patch) };
      await writeFile(path, serialise(next, read.body), "utf8");
      return;
    }
    throw new Error(`memory document not found: ${id}`);
  }

  async delete(id: string): Promise<void> {
    for (const path of await this.listPaths()) {
      const read = await this.options.store.read(path);
      if (read.frontmatter.id === id) {
        await this.options.store.delete(path);
        return;
      }
    }
  }

  private async listPaths(types?: readonly string[]): Promise<string[]> {
    if (types === undefined) return this.options.store.list(this.options.scope);
    const paths = await Promise.all(
      types.map((type) => this.options.store.list(this.options.scope, coerceMemoryType(type))),
    );
    return paths.flat();
  }
}

export interface SqliteMemoryIndexOptions {
  storage: Storage;
}

/** SQLite-backed implementation of the core MemoryIndex contract. */
export class SqliteMemoryIndex implements MemoryIndex {
  constructor(private readonly options: SqliteMemoryIndexOptions) {}

  async upsert(doc: MemoryDocument): Promise<void> {
    this.options.storage.upsertChunk(documentToChunk(doc));
  }

  async remove(id: string): Promise<void> {
    this.options.storage.deleteChunk(id);
  }

  async searchText(query: TextQuery): Promise<Candidate[]> {
    return this.options.storage
      .searchBM25(query.query, query.limit ?? 20)
      .filter((hit) => query.types === undefined || query.types.includes(hit.chunk.type))
      .map((hit) => hitToCandidate(hit.chunk, hit.score, "sqlite-bm25"));
  }

  async searchVector(query: VectorQuery): Promise<Candidate[]> {
    return this.options.storage
      .searchVector(query.vector, query.limit ?? 20)
      .filter((hit) => query.types === undefined || query.types.includes(hit.chunk.type))
      .map((hit) => hitToCandidate(hit.chunk, hit.score, query.indexId));
  }

  async upsertEntities(id: string, entities: EntityMention[]): Promise<void> {
    this.options.storage.upsertChunkEntities(
      id,
      entities.map((entity) => entity.label),
    );
  }

  async upsertEdges(edges: CoreEdge[]): Promise<void> {
    this.options.storage.upsertEdges(edges.map(coreEdgeToStorageEdge));
  }

  async rebuildFrom(repo: MemoryRepository): Promise<RebuildReport> {
    const docs = await repo.list();
    let indexed = 0;
    const errors: RebuildReport["errors"] = [];
    for (const doc of docs) {
      try {
        await this.upsert(doc);
        indexed++;
      } catch (err) {
        errors.push({ id: doc.id, message: (err as Error).message });
      }
    }
    return { documentsRead: docs.length, documentsIndexed: indexed, errors };
  }
}

export function createCoreRepository(options: MarkdownRepositoryOptions): MemoryRepository {
  return new MarkdownMemoryRepository(options);
}

export function createCoreIndex(options: SqliteMemoryIndexOptions): MemoryIndex {
  return new SqliteMemoryIndex(options);
}

function documentToFrontmatter(doc: MemoryDocument): Frontmatter {
  const fm: Frontmatter = { id: doc.id, type: doc.type };
  for (const [key, value] of Object.entries(doc.metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      fm[key] = value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) fm[key] = value;
  }
  return fm;
}

function metadataPatchToFrontmatter(patch: MetadataPatch): Frontmatter {
  const fm: Frontmatter = {};
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      fm[key] = value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) fm[key] = value;
  }
  return fm;
}

function readToDocument(body: string, fm: Frontmatter, fallbackType: string): MemoryDocument {
  const id = typeof fm.id === "string" ? fm.id : crypto.randomUUID();
  const type = typeof fm.type === "string" ? fm.type : fallbackType;
  return {
    id,
    type,
    body,
    metadata: { ...fm },
    provenance: {
      source: typeof fm.sourceKind === "string" ? fm.sourceKind : "markdown-wiki",
      createdAt: typeof fm.recordedAt === "string" ? fm.recordedAt : new Date(0).toISOString(),
    },
  };
}

function documentToChunk(doc: MemoryDocument): Chunk {
  return {
    id: doc.id,
    path: doc.id,
    type: coerceMemoryType(doc.type),
    ordinal: 0,
    content: doc.body,
    metadata: doc.metadata,
  };
}

function hitToCandidate(chunk: Chunk, score: number, source: string): Candidate {
  return {
    id: chunk.id,
    score,
    source,
    document: {
      id: chunk.id,
      type: chunk.type,
      body: chunk.content,
      metadata: chunk.metadata ?? {},
      provenance: { source: "sqlite-index", createdAt: new Date(0).toISOString() },
    },
    ...(chunk.metadata !== undefined ? { metadata: chunk.metadata } : {}),
  };
}

function coreEdgeToStorageEdge(edge: CoreEdge): Edge {
  return {
    fromChunkId: edge.from,
    toChunkId: edge.to,
    linkType: edge.kind,
    ...(typeof edge.metadata?.context === "string" ? { context: edge.metadata.context } : {}),
  };
}

function coerceMemoryType(type: string): MemoryType {
  const allowed = new Set<MemoryType>([
    "facts",
    "preferences",
    "events",
    "decisions",
    "context",
    "observations",
    "aggregates",
    "episodic",
    "reflections",
    "patterns",
    "procedural",
  ]);
  return allowed.has(type as MemoryType) ? (type as MemoryType) : "context";
}
