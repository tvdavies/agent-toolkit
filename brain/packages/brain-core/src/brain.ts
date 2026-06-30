import type { BrainEventMap, BrainEventName } from "./events.js";
import type { BrainExtensionAPI, BrainLogger, BrainModule, RegistrationOptions } from "./module.js";
import {
  createInMemoryModuleStateStore,
  createInMemoryRuntimeStore,
  InMemoryRepository,
  NoopIndex,
} from "./noop-stores.js";
import {
  type RecallInput,
  type RecallResult,
  type RememberInput,
  type RememberResult,
  runRecall,
  runRemember,
} from "./pipeline.js";
import { ModuleRegistry } from "./registry.js";
import type {
  BrainRuntimeStore,
  MemoryIndex,
  MemoryRepository,
  ModuleStateStore,
} from "./stores.js";

export interface CreateBrainOptions {
  modules?: BrainModule[];
  repository?: MemoryRepository;
  index?: MemoryIndex;
  runtime?: BrainRuntimeStore;
  state?: ModuleStateStore;
  logger?: BrainLogger;
}

export interface BrainRuntime {
  registry: ModuleRegistry;
  emit<E extends BrainEventName>(event: E, context: BrainEventMap[E]): Promise<void>;
  start(reason?: "start" | "reload"): Promise<void>;
  shutdown(): Promise<void>;
  reload(modules?: BrainModule[]): Promise<void>;
  remember(input: RememberInput): Promise<RememberResult>;
  recall(input: RecallInput): Promise<RecallResult>;
}

const consoleLogger: BrainLogger = {
  debug: (message, metadata) => console.debug(message, metadata ?? ""),
  info: (message, metadata) => console.info(message, metadata ?? ""),
  warn: (message, metadata) => console.warn(message, metadata ?? ""),
  error: (message, metadata) => console.error(message, metadata ?? ""),
};

/** Create a brain runtime and install modules against stable repository/index/runtime boundaries. */
export async function createBrain(options: CreateBrainOptions = {}): Promise<BrainRuntime> {
  const runtime = new DefaultBrainRuntime(options);
  await runtime.reload(options.modules ?? []);
  return runtime;
}

class DefaultBrainRuntime implements BrainRuntime {
  readonly registry = new ModuleRegistry();
  private modules: BrainModule[] = [];
  private readonly repository: MemoryRepository;
  private readonly index: MemoryIndex;
  private readonly runtimeStore: BrainRuntimeStore;
  private readonly state: ModuleStateStore;
  private readonly logger: BrainLogger;

  constructor(options: CreateBrainOptions) {
    this.repository = options.repository ?? new InMemoryRepository();
    this.index = options.index ?? new NoopIndex();
    this.runtimeStore = options.runtime ?? createInMemoryRuntimeStore();
    this.state = options.state ?? createInMemoryModuleStateStore();
    this.logger = options.logger ?? consoleLogger;
  }

  async emit<E extends BrainEventName>(event: E, context: BrainEventMap[E]): Promise<void> {
    await this.registry.emit(event, context);
  }

  async start(reason: "start" | "reload" = "start"): Promise<void> {
    await this.emit("runtime:start", { reason });
  }

  async shutdown(): Promise<void> {
    await this.emit("runtime:shutdown", { reason: "shutdown" });
    for (const module of [...this.modules].reverse()) await module.teardown?.();
    this.registry.clear();
  }

  async reload(modules: BrainModule[] = this.modules): Promise<void> {
    if (this.modules.length > 0) await this.shutdown();
    this.modules = modules;
    for (const module of modules) await module.setup(this.apiFor(module.name));
    await this.start("reload");
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    return runRemember(this.registry, this.repository, this.index, input);
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    return runRecall(this.registry, input);
  }

  private apiFor(moduleName: string): BrainExtensionAPI {
    const register = <T>(
      target: Parameters<ModuleRegistry["register"]>[0],
      item: T,
      options?: RegistrationOptions,
    ) => {
      this.registry.register(target as never, moduleName, item as never, options);
    };
    return {
      on: (event, handler) => this.registry.on(moduleName, event, handler),
      registerWriter: (writer, options) => register(this.registry.writers, writer, options),
      registerExtractor: (extractor, options) =>
        register(this.registry.extractors, extractor, options),
      registerCandidateGenerator: (generator, options) =>
        register(this.registry.candidateGenerators, generator, options),
      registerRanker: (ranker, options) => register(this.registry.rankers, ranker, options),
      registerSelector: (selector, options) => register(this.registry.selectors, selector, options),
      registerConsolidator: (consolidator, options) =>
        register(this.registry.consolidators, consolidator, options),
      registerReflector: (reflector, options) =>
        register(this.registry.reflectors, reflector, options),
      registerEmbeddingModel: (model) => this.registry.embeddingModels.set(model.id, model),
      registerVectorIndex: (spec) => this.registry.vectorIndexes.set(spec.id, spec),
      registerCommand: (name, command) =>
        this.registry.commands.set(name, { module: moduleName, command }),
      repository: this.repository,
      index: this.index,
      runtime: this.runtimeStore,
      state: this.state,
      logger: this.logger,
    };
  }
}
