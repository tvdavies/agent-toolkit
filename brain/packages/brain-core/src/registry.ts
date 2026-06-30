import type {
  BrainCommand,
  CandidateGenerator,
  Consolidator,
  DeterministicExtractor,
  OrderedRegistration,
  Ranker,
  Reflector,
  Selector,
  Writer,
} from "./components.js";
import type { BrainEventHandler, BrainEventMap, BrainEventName } from "./events.js";
import type { RegistrationOptions } from "./module.js";
import type { EmbeddingModel, VectorIndexSpec } from "./types.js";

type HandlerRecord = {
  event: BrainEventName;
  module: string;
  handler: (context: BrainEventMap[BrainEventName]) => void | Promise<void>;
};

/** In-memory registry owned by one brain runtime generation. */
export class ModuleRegistry {
  private handlers: HandlerRecord[] = [];
  readonly writers: OrderedRegistration<Writer>[] = [];
  readonly extractors: OrderedRegistration<DeterministicExtractor>[] = [];
  readonly candidateGenerators: OrderedRegistration<CandidateGenerator>[] = [];
  readonly rankers: OrderedRegistration<Ranker>[] = [];
  readonly selectors: OrderedRegistration<Selector>[] = [];
  readonly consolidators: OrderedRegistration<Consolidator>[] = [];
  readonly reflectors: OrderedRegistration<Reflector>[] = [];
  readonly embeddingModels = new Map<string, EmbeddingModel>();
  readonly vectorIndexes = new Map<string, VectorIndexSpec>();
  readonly commands = new Map<string, { module: string; command: BrainCommand }>();

  on<E extends BrainEventName>(module: string, event: E, handler: BrainEventHandler<E>): void {
    this.handlers.push({ event, module, handler: handler as HandlerRecord["handler"] });
  }

  register<T>(
    target: OrderedRegistration<T>[],
    module: string,
    item: T,
    options: RegistrationOptions = {},
  ): void {
    target.push({ item, module, stage: options.stage, order: options.order ?? 0 });
    target.sort((a, b) => a.order - b.order);
  }

  async emit<E extends BrainEventName>(event: E, context: BrainEventMap[E]): Promise<void> {
    for (const record of this.handlers) {
      if (record.event !== event) continue;
      await (record.handler as BrainEventHandler<E>)(context);
    }
  }

  clear(): void {
    this.handlers = [];
    this.writers.length = 0;
    this.extractors.length = 0;
    this.candidateGenerators.length = 0;
    this.rankers.length = 0;
    this.selectors.length = 0;
    this.consolidators.length = 0;
    this.reflectors.length = 0;
    this.embeddingModels.clear();
    this.vectorIndexes.clear();
    this.commands.clear();
  }
}
