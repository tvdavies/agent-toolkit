import type { BuiltInRecallServices } from "./builtin-stages.js";
import type { CandidateGenerationResult } from "./candidates.js";
import type { FinalizeRetrievalResult } from "./finalize.js";
import type { BuiltInRecallModule } from "./modules.js";
import type { PreparedRecall } from "./prepare.js";
import {
  runBoostStage,
  runCandidateStage,
  runFinalizeStage,
  runFuseStage,
  runPrepareStage,
} from "./stage-runner.js";
import type { RetrievalHit } from "./types.js";

export interface RecallExecutionState {
  prepared?: PreparedRecall;
  generated?: CandidateGenerationResult;
  hits: RetrievalHit[];
  decayActive: boolean;
  finalized?: FinalizeRetrievalResult;
}

export interface BuiltInRecallHandlerContext {
  services: BuiltInRecallServices;
  primaryStorage: NonNullable<BuiltInRecallServices["storages"][number]>;
  state: RecallExecutionState;
  isEnabled(id: string): boolean;
}

export type BuiltInRecallHandler = (ctx: BuiltInRecallHandlerContext) => void | Promise<void>;

export interface ExecutableBuiltInRecallModule extends BuiltInRecallModule {
  run: BuiltInRecallHandler;
}

const prepareHandler: BuiltInRecallHandler = (ctx) => {
  ctx.state.prepared = runPrepareStage(ctx.services, ctx.isEnabled);
};

const candidateHandler: BuiltInRecallHandler = async (ctx) => {
  ctx.state.generated = await runCandidateStage(
    ctx.services,
    requirePrepared(ctx.state),
    ctx.primaryStorage,
    ctx.isEnabled,
  );
};

const boostHandler: BuiltInRecallHandler = (ctx) => {
  const boosted = runBoostStage(
    ctx.services,
    requirePrepared(ctx.state),
    ctx.primaryStorage,
    ctx.state.hits,
    ctx.isEnabled,
  );
  ctx.state.hits = boosted.hits;
  ctx.state.decayActive = boosted.decayActive;
};

export const EXECUTABLE_BUILT_IN_RECALL_MODULES: readonly ExecutableBuiltInRecallModule[] = [
  { id: "brain/temporal-expansion", stage: "prepare", order: 10, run: prepareHandler },
  { id: "brain/intent-planner", stage: "prepare", order: 20, run: prepareHandler },
  { id: "brain/bm25", stage: "candidate", order: 10, run: candidateHandler },
  { id: "brain/vector", stage: "candidate", order: 20, run: candidateHandler },
  { id: "brain/entity", stage: "candidate", order: 30, run: candidateHandler },
  { id: "brain/fallback-query-rewrite", stage: "candidate", order: 40, run: candidateHandler },
  {
    id: "brain/rrf",
    stage: "fuse",
    order: 10,
    run: (ctx) => {
      ctx.state.hits = runFuseStage(requireGenerated(ctx.state));
    },
  },
  { id: "brain/cosine-rescore", stage: "boost", order: 10, run: boostHandler },
  { id: "brain/type-boost", stage: "boost", order: 20, run: boostHandler },
  { id: "brain/temporal-decay", stage: "boost", order: 30, run: boostHandler },
  { id: "brain/status-penalty", stage: "boost", order: 40, run: boostHandler },
  { id: "brain/assistant-reference-boost", stage: "boost", order: 50, run: boostHandler },
  { id: "brain/backlink-boost", stage: "boost", order: 60, run: boostHandler },
  { id: "brain/authority-boost", stage: "boost", order: 70, run: boostHandler },
  { id: "brain/usage-boost", stage: "boost", order: 80, run: boostHandler },
  {
    id: "brain/reranker",
    stage: "rank",
    order: 10,
    async run(ctx) {
      ctx.state.finalized = await runFinalizeStage(
        ctx.services,
        requirePrepared(ctx.state),
        ctx.state.hits,
        ctx.state.decayActive,
        ctx.isEnabled,
      );
      ctx.state.hits = ctx.state.finalized.hits;
    },
  },
];

export function requirePrepared(state: RecallExecutionState): PreparedRecall {
  if (state.prepared === undefined) throw new Error("recall stage requires prepared query state");
  return state.prepared;
}

export function requireGenerated(state: RecallExecutionState): CandidateGenerationResult {
  if (state.generated === undefined) throw new Error("recall stage requires generated candidates");
  return state.generated;
}
