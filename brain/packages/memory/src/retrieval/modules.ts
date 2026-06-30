export type RecallStageKind =
  | "prepare"
  | "candidate"
  | "fuse"
  | "boost"
  | "rank"
  | "select"
  | "observe";

export interface BuiltInRecallModule {
  id: string;
  stage: RecallStageKind;
  order: number;
}

export const BUILT_IN_RECALL_MODULES: readonly BuiltInRecallModule[] = [
  { id: "brain/temporal-expansion", stage: "prepare", order: 10 },
  { id: "brain/intent-planner", stage: "prepare", order: 20 },
  { id: "brain/bm25", stage: "candidate", order: 10 },
  { id: "brain/vector", stage: "candidate", order: 20 },
  { id: "brain/entity", stage: "candidate", order: 30 },
  { id: "brain/fallback-query-rewrite", stage: "candidate", order: 40 },
  { id: "brain/rrf", stage: "fuse", order: 10 },
  { id: "brain/cosine-rescore", stage: "boost", order: 10 },
  { id: "brain/type-boost", stage: "boost", order: 20 },
  { id: "brain/temporal-decay", stage: "boost", order: 30 },
  { id: "brain/status-penalty", stage: "boost", order: 40 },
  { id: "brain/assistant-reference-boost", stage: "boost", order: 50 },
  { id: "brain/backlink-boost", stage: "boost", order: 60 },
  { id: "brain/authority-boost", stage: "boost", order: 70 },
  { id: "brain/usage-boost", stage: "boost", order: 80 },
  { id: "brain/reranker", stage: "rank", order: 10 },
  { id: "brain/retrieval-log", stage: "observe", order: 10 },
] as const;

export const BUILT_IN_RECALL_MODULE_IDS = BUILT_IN_RECALL_MODULES.map((module) => module.id);

export class RecallModulePlan {
  private readonly enabled: ReadonlySet<string>;

  constructor(readonly moduleIds: readonly string[]) {
    this.enabled = new Set(moduleIds);
  }

  isEnabled(id: string): boolean {
    return this.enabled.has(id);
  }

  enabledBuiltInsByStage(stage: RecallStageKind): BuiltInRecallModule[] {
    return this.enabledBuiltIns(BUILT_IN_RECALL_MODULES).filter((module) => module.stage === stage);
  }

  enabledBuiltIns<T extends BuiltInRecallModule>(modules: readonly T[]): T[] {
    const byId = new Map(modules.map((module) => [module.id, module]));
    return this.moduleIds.flatMap((id) => {
      const module = byId.get(id);
      return module === undefined ? [] : [module];
    });
  }
}
