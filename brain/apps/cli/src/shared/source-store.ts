import type {
  IngestDecision,
  IngestRecord,
  SourceConfig,
  SourceEnrichmentJob,
  SourceLedgerEntry,
  SourceSearchHit,
  SourcesConfig,
} from "./sources.js";
import {
  claimSourceEnrichmentJobs,
  completeSourceEnrichmentJob,
  decideAndUpdateLedger,
  enqueueSourceEnrichmentJob,
  failSourceEnrichmentJob,
  listSourceEnrichmentJobs,
  markSourceDocumentDeleted,
  readCursor,
  readLedger,
  readSourceDocumentRecord,
  readSourcesConfig,
  rebuildSourceIndexFromArchive,
  runCommandConnector,
  searchSourceDocuments,
  writeCursor,
  writeSourcesConfig,
} from "./sources.js";

export interface SourceStore {
  decideAndUpdate(record: IngestRecord): { decision: IngestDecision; entry: SourceLedgerEntry };
  readLedger(): Record<string, SourceLedgerEntry>;
  search(query: string, limit?: number): SourceSearchHit[];
  enqueueEnrichment(entry: SourceLedgerEntry): SourceEnrichmentJob;
  listJobs(limit?: number): SourceEnrichmentJob[];
  claimJobs(limit?: number): SourceEnrichmentJob[];
  completeJob(id: string): void;
  failJob(id: string, error: string): void;
  readDocumentRecord(key: string): IngestRecord | undefined;
  markDeleted(sourceInstanceId: string, externalId: string): boolean;
  rebuildFromArchive(): { packages: number };
  readSourcesConfig(): SourcesConfig;
  writeSourcesConfig(config: SourcesConfig): void;
  readCursor(sourceInstanceId: string): unknown;
  writeCursor(sourceInstanceId: string, cursor: unknown): void;
  runCommandConnector(source: SourceConfig, cursor: unknown): Promise<string>;
}

export function createDefaultSourceStore(homeDir: string): SourceStore {
  return {
    decideAndUpdate: (record) => decideAndUpdateLedger(homeDir, record),
    readLedger: () => readLedger(homeDir),
    search: (query, limit) => searchSourceDocuments(homeDir, query, limit),
    enqueueEnrichment: (entry) => enqueueSourceEnrichmentJob(homeDir, entry),
    listJobs: (limit) => listSourceEnrichmentJobs(homeDir, limit),
    claimJobs: (limit) => claimSourceEnrichmentJobs(homeDir, limit),
    completeJob: (id) => completeSourceEnrichmentJob(homeDir, id),
    failJob: (id, error) => failSourceEnrichmentJob(homeDir, id, error),
    readDocumentRecord: (key) => readSourceDocumentRecord(homeDir, key),
    markDeleted: (sourceInstanceId, externalId) =>
      markSourceDocumentDeleted(homeDir, sourceInstanceId, externalId),
    rebuildFromArchive: () => rebuildSourceIndexFromArchive(homeDir),
    readSourcesConfig: () => readSourcesConfig(homeDir),
    writeSourcesConfig: (config) => writeSourcesConfig(homeDir, config),
    readCursor: (sourceInstanceId) => readCursor(homeDir, sourceInstanceId),
    writeCursor: (sourceInstanceId, cursor) => writeCursor(homeDir, sourceInstanceId, cursor),
    runCommandConnector,
  };
}
