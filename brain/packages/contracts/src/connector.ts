import { z } from "zod";
import { EntityRef, SourceRef } from "./common.js";

export const ToolTag = z.enum(["read", "write", "destructive"]);
export type ToolTag = z.infer<typeof ToolTag>;

export const ToolContext = z.object({
  sessionId: z.string(),
  turnId: z.string(),
});
export type ToolContext = z.infer<typeof ToolContext> & { abortSignal?: AbortSignal };

export interface Tool<A = unknown, R = unknown> {
  name: string;
  description: string;
  argsSchema: z.ZodType<A>;
  resultSchema: z.ZodType<R>;
  tags?: ToolTag[];
  call(args: A, ctx: ToolContext): Promise<R>;
}

export const IngestedItem = z.object({
  source: SourceRef,
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  ingestedAt: z.date(),
  entities: z.array(EntityRef).default([]),
});
export type IngestedItem = z.infer<typeof IngestedItem>;

export type BackfillOptions = {
  since?: Date;
  until?: Date;
  limit?: number;
};

export type Unsubscribe = () => Promise<void> | void;

export interface Connector {
  readonly id: string;
  readonly scopes: readonly string[];
  tools(): Tool[];
  entityTypes?(): string[];
  backfill?(opts?: BackfillOptions): AsyncIterable<IngestedItem>;
  subscribe?(handler: (item: IngestedItem) => Promise<void>): Promise<Unsubscribe>;
}
