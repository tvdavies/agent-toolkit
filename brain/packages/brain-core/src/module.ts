import type {
  BrainCommand,
  CandidateGenerator,
  Consolidator,
  DeterministicExtractor,
  Ranker,
  Reflector,
  Selector,
  Writer,
} from "./components.js";
import type { BrainEventHandler, BrainEventName } from "./events.js";
import type {
  BrainRuntimeStore,
  MemoryIndex,
  MemoryRepository,
  ModuleStateStore,
} from "./stores.js";
import type { Capability, EmbeddingModel, VectorIndexSpec } from "./types.js";

/** Logger facade exposed to modules. Implementations may write to CLI output, daemon logs, or tests. */
export interface BrainLogger {
  /** Emit verbose diagnostic information useful while developing an extension. */
  debug(message: string, metadata?: Record<string, unknown>): void;
  /** Emit normal operational information. */
  info(message: string, metadata?: Record<string, unknown>): void;
  /** Emit a recoverable problem. */
  warn(message: string, metadata?: Record<string, unknown>): void;
  /** Emit an error. Do not include secrets in metadata. */
  error(message: string, metadata?: Record<string, unknown>): void;
}

/** Ordering options for pipeline component registration. */
export interface RegistrationOptions {
  /** Optional named stage. Use this for coarse grouping when an API supports it. */
  stage?: string;
  /** Numeric order within a component list. Lower values run first. Defaults to 0. */
  order?: number;
}

/**
 * Stable API handed to modules during setup.
 *
 * This is the public extension surface. It deliberately exposes stable services
 * and typed registration methods instead of raw SQLite handles or filesystem
 * internals. Storage-adapter and migration modules may eventually receive lower
 * level handles through a separate high-trust API.
 */
export interface BrainExtensionAPI {
  /** Subscribe to a lifecycle event. Handlers run in module load/order sequence. */
  on<E extends BrainEventName>(event: E, handler: BrainEventHandler<E>): void;
  /** Register a write-stage component that turns remember inputs into documents. */
  registerWriter(writer: Writer, options?: RegistrationOptions): void;
  /** Register a deterministic extraction component. */
  registerExtractor(extractor: DeterministicExtractor, options?: RegistrationOptions): void;
  /** Register a recall component that produces candidates from a query. */
  registerCandidateGenerator(generator: CandidateGenerator, options?: RegistrationOptions): void;
  /** Register a recall component that reorders or rescales candidates. */
  registerRanker(ranker: Ranker, options?: RegistrationOptions): void;
  /** Register a recall component that chooses final results. */
  registerSelector(selector: Selector, options?: RegistrationOptions): void;
  /** Register a consolidation component for cycle-time memory maintenance. */
  registerConsolidator(consolidator: Consolidator, options?: RegistrationOptions): void;
  /** Register a reflection component for cycle-time synthesis. */
  registerReflector(reflector: Reflector, options?: RegistrationOptions): void;
  /** Register an embedding model by id. Vector indexes refer to this id. */
  registerEmbeddingModel(model: EmbeddingModel): void;
  /** Register a named vector index specification. Incompatible changes require rebuild semantics. */
  registerVectorIndex(spec: VectorIndexSpec): void;
  /** Register a command for brain CLIs/chats that support command dispatch. */
  registerCommand(name: string, command: BrainCommand): void;
  /** Authoritative memory documents. Prefer returning docs to core when possible. */
  repository: MemoryRepository;
  /** Derived search structures. Rebuildable in wiki-source mode. */
  index: MemoryIndex;
  /** Runtime queues, locks, usage counters, logs, L0, and cache services. */
  runtime: BrainRuntimeStore;
  /** Module-scoped persistent state. Use namespaced keys. */
  state: ModuleStateStore;
  /** Module logger. */
  logger: BrainLogger;
}

/**
 * Behaviour module contract.
 *
 * Built-ins and third-party extensions use the same shape. A module should do
 * all registration in `setup()`, keep long-lived resources behind `teardown()`,
 * and declare every capability it needs so loaders can validate trust.
 */
export interface BrainModule {
  /** Stable module id, normally reverse-DNS or `brain/name` for built-ins. */
  name: string;
  /** Semver-ish module version used for diagnostics and future migration gates. */
  version: string;
  /** Privileges requested by this module. High-capability modules require stronger trust. */
  capabilities?: Capability[];
  /** Register handlers/components and initialize module state. */
  setup(api: BrainExtensionAPI): void | Promise<void>;
  /** Release timers, network connections, watchers, and other in-memory resources. */
  teardown?(): void | Promise<void>;
}
