import { z } from "zod";

export const INGEST_SCHEMA = "brain.ingest.v1";
export const SOURCE_ENVELOPE_SCHEMA = "brain.source-envelope.v1";

export const SourceParticipant = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    role: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();
export type SourceParticipant = z.infer<typeof SourceParticipant>;

export const SourceEnvelope = z
  .object({
    schema: z.literal(SOURCE_ENVELOPE_SCHEMA).optional(),
    sourceKind: z.string().min(1),
    sourceId: z.string().min(1),
    sourceInstanceId: z.string().min(1).optional(),
    sourceVersion: z.string().optional(),
    recordedAt: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    contentHash: z.string().optional(),
    participants: z.array(SourceParticipant).optional(),
    workspace: z
      .object({
        cwd: z.string().optional(),
        gitRepo: z.string().optional(),
        branch: z.string().optional(),
        projectName: z.string().optional(),
      })
      .passthrough()
      .optional(),
    parent: z
      .object({
        sourceKind: z.string().min(1),
        sourceId: z.string().min(1),
        title: z.string().optional(),
        url: z.string().optional(),
      })
      .passthrough()
      .optional(),
    entities: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type SourceEnvelope = z.infer<typeof SourceEnvelope>;

export const IngestRecord = z.object({
  schema: z.literal(INGEST_SCHEMA).optional(),
  source: z.object({
    instanceId: z.string().min(1),
    kind: z.string().min(1),
    externalId: z.string().min(1),
    uri: z.string().optional(),
    account: z.string().optional(),
    collection: z.string().optional(),
  }),
  title: z.string().optional(),
  body: z.string().min(1),
  bodyFormat: z.enum(["text", "markdown", "html", "json"]).optional(),
  summary: z.string().optional(),
  author: z.record(z.string(), z.unknown()).optional(),
  participants: z.array(z.record(z.string(), z.unknown())).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  observedAt: z.string().optional(),
  ingestedAt: z.string().optional(),
  refs: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  visibility: z.enum(["private", "work", "public", "secret"]).optional(),
  importance: z.enum(["low", "normal", "high"]).optional(),
  thread: z
    .object({ id: z.string(), parentId: z.string().optional(), position: z.number().optional() })
    .optional(),
  attachments: z.array(z.record(z.string(), z.unknown())).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  envelope: SourceEnvelope.optional(),
  raw: z.unknown().optional(),
});
export type IngestRecord = z.infer<typeof IngestRecord>;

export type ConnectorRecord = {
  type: "record";
  record: IngestRecord;
};

export type ConnectorCheckpoint = {
  type: "checkpoint";
  cursor: unknown;
};

export type ConnectorLog = {
  type: "log";
  message: string;
};

export type ConnectorOutputLine =
  | ConnectorRecord
  | ConnectorCheckpoint
  | ConnectorLog
  | IngestRecord;
