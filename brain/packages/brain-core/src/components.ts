import type { CycleContext, RecallContext, RememberContext } from "./events.js";
import type { Candidate, MemoryDocument } from "./types.js";

export interface Writer {
  id: string;
  write(ctx: RememberContext): Promise<MemoryDocument[]> | MemoryDocument[];
}

export interface DeterministicExtractor {
  id: string;
  extract(ctx: RememberContext): Promise<MemoryDocument[]> | MemoryDocument[];
}

export interface CandidateGenerator {
  id: string;
  generate(ctx: RecallContext): Promise<Candidate[]> | Candidate[];
}

export interface Ranker {
  id: string;
  rank(ctx: RecallContext): Promise<Candidate[]> | Candidate[];
}

export interface Selector {
  id: string;
  select(ctx: RecallContext): Promise<Candidate[]> | Candidate[];
}

export interface Consolidator {
  id: string;
  consolidate(ctx: CycleContext): Promise<void> | void;
}

export interface Reflector {
  id: string;
  reflect(ctx: CycleContext): Promise<void> | void;
}

export interface BrainCommand {
  description?: string;
  run(args: string[]): Promise<void> | void;
}

export interface OrderedRegistration<T> {
  item: T;
  module: string;
  stage?: string;
  order: number;
}
