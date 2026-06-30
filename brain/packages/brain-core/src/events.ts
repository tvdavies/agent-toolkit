import type { Candidate, MemoryDocument } from "./types.js";

export interface RememberContext {
  input: string;
  documents: MemoryDocument[];
  metadata: Record<string, unknown>;
}

export interface RecallContext {
  query: string;
  candidates: Candidate[];
  selected: Candidate[];
  metadata: Record<string, unknown>;
}

export interface CycleContext {
  reason: string;
  metadata: Record<string, unknown>;
}

export interface PolicyContext {
  id: string;
  proposal?: unknown;
  metadata: Record<string, unknown>;
}

export interface RuntimeContext {
  reason: "start" | "reload" | "shutdown";
}

export interface BrainEventMap {
  "runtime:start": RuntimeContext;
  "runtime:shutdown": RuntimeContext;
  "remember:start": RememberContext;
  "remember:event": RememberContext;
  "extract:before": RememberContext;
  "extract:after": RememberContext;
  "persist:before": RememberContext;
  "persist:after": RememberContext;
  "recall:start": RecallContext;
  "query:prepare": RecallContext;
  "candidates:generate": RecallContext;
  "candidates:fuse": RecallContext;
  "rank:apply": RecallContext;
  "select:apply": RecallContext;
  "recall:end": RecallContext;
  "reflect:start": CycleContext;
  "reflect:end": CycleContext;
  "consolidate:start": CycleContext;
  "consolidate:end": CycleContext;
  "cycle:start": CycleContext;
  "cycle:end": CycleContext;
  "feedback:record": PolicyContext;
  "retrieval:impression": PolicyContext;
  "policy:propose": PolicyContext;
  "policy:activate": PolicyContext;
}

export type BrainEventName = keyof BrainEventMap;
export type BrainEventHandler<E extends BrainEventName> = (
  context: BrainEventMap[E],
) => void | Promise<void>;
