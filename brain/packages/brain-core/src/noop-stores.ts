import type {
  BrainRuntimeStore,
  CacheStore,
  L0Store,
  LockStore,
  MemoryIndex,
  MemoryRepository,
  ModuleStateStore,
  QueueStore,
  RetrievalLogStore,
  UsageStore,
} from "./stores.js";
import type {
  Candidate,
  Edge,
  EntityMention,
  MemoryDocument,
  MetadataPatch,
  RebuildReport,
  RepoFilter,
  TextQuery,
  VectorQuery,
} from "./types.js";

/** Minimal in-memory repository useful for tests and static module wiring. */
export class InMemoryRepository implements MemoryRepository {
  private docs = new Map<string, MemoryDocument>();
  async put(doc: MemoryDocument): Promise<void> {
    this.docs.set(doc.id, doc);
  }
  async get(id: string): Promise<MemoryDocument | undefined> {
    return this.docs.get(id);
  }
  async list(filter: RepoFilter = {}): Promise<MemoryDocument[]> {
    return [...this.docs.values()].filter(
      (doc) => !filter.types || filter.types.includes(doc.type),
    );
  }
  async updateMetadata(id: string, patch: MetadataPatch): Promise<void> {
    const doc = this.docs.get(id);
    if (doc) this.docs.set(id, { ...doc, metadata: { ...doc.metadata, ...patch } });
  }
  async delete(id: string): Promise<void> {
    this.docs.delete(id);
  }
}

/** No-op index implementation for runtimes that have not selected an index adapter yet. */
export class NoopIndex implements MemoryIndex {
  async upsert(_doc: MemoryDocument): Promise<void> {}
  async remove(_id: string): Promise<void> {}
  async searchText(_query: TextQuery): Promise<Candidate[]> {
    return [];
  }
  async searchVector(_query: VectorQuery): Promise<Candidate[]> {
    return [];
  }
  async upsertEntities(_id: string, _entities: EntityMention[]): Promise<void> {}
  async upsertEdges(_edges: Edge[]): Promise<void> {}
  async rebuildFrom(repo: MemoryRepository): Promise<RebuildReport> {
    const docs = await repo.list();
    return { documentsRead: docs.length, documentsIndexed: 0, errors: [] };
  }
}

class MemoryMapStore implements CacheStore, L0Store, ModuleStateStore {
  private values = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const queue: QueueStore = {
  async enqueue() {
    return crypto.randomUUID();
  },
  async dequeue() {
    return undefined;
  },
  async ack() {},
};
const locks: LockStore = {
  async acquire() {
    return { dispose() {} };
  },
};
const usage: UsageStore = {
  async bump() {},
  async get() {
    return 0;
  },
};
const retrievalLog: RetrievalLogStore = { async record() {} };

export function createInMemoryRuntimeStore(): BrainRuntimeStore {
  return {
    queue,
    locks,
    usage,
    retrievalLog,
    l0: new MemoryMapStore(),
    cache: new MemoryMapStore(),
  };
}

export function createInMemoryModuleStateStore(): ModuleStateStore {
  return new MemoryMapStore();
}
