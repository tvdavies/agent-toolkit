/**
 * Construct a Memory pointed at a real on-disk brain.
 *
 * Two paths matter:
 *   - `BRAIN_HOME` (`~/brain/`) — machine-local: config, OAuth tokens,
 *     daemon logs. NOT git-tracked.
 *   - `BRAIN_ROOT` (`~/brain/memories/`) — the wiki itself: markdown
 *     source of truth + `.cache/` derived index. The git boundary.
 *     Defaults to `<home>/memories` when unset.
 *
 * The CLI takes `(homeDir, rootDir, scope)` for write/query operations.
 * Resolution order for each: CLI flag → env var → default.
 *
 * Models per purpose (extractor / observer / consolidator /
 * contextualiser / embedder / reranker) are read from
 * `<homeDir>/config.yaml` via `loadBrainConfig`. Eval baselines pin
 * their own stack and don't read this config — so eval reruns stay
 * reproducible regardless of how the user has their brain configured.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  type BrainModule,
  type BrainRuntime,
  createBrain,
  loadExtensions,
  type MemoryDocument,
  type MemoryIndex,
  type MemoryRepository,
} from "@ai-assistant/brain-core";
import type { Memory } from "@ai-assistant/contracts";
import {
  type BrainConfig,
  BUILT_IN_RECALL_MODULE_IDS,
  buildChatModel,
  createContextualiser,
  createCoreIndex,
  createCoreRepository,
  createDeterministicWriter,
  createEmbeddingCache,
  createExtractor,
  createFactCache,
  createGatewayEmbedder,
  createHeuristicReranker,
  createHybridWriter,
  createLLMReranker,
  createLlmConsolidator,
  createLocalEmbedder,
  createMarkdownStore,
  createObservationCache,
  createObservationWriter,
  createOurMemory,
  createSqliteStorage,
  createUsageMeter,
  DEFAULT_ASYNC_WRITERS,
  DEFAULT_RECALL_MODULES,
  DEFAULT_REMEMBER_WRITERS,
  DEFAULT_SYNC_WRITER,
  type Embedder,
  type EmbeddingCache,
  ENV_VAR_FOR_TYPE,
  type ExtensionCandidateGenerator,
  type ExtensionRanker,
  type ExtensionSelector,
  enabledModuleId,
  enabledModuleIds,
  type FactCache,
  loadBrainConfig,
  type MarkdownStore,
  type ModelSpec,
  type ProviderSpec,
  proceduralWriter,
  readApiKey,
  type Storage,
  type UsageMeter,
  verbatimWriter,
  type WriteEvent,
  type Writer,
  type WrittenChunk,
  withEmbeddingCache,
} from "@ai-assistant/memory";
import { authDir as authDirOf } from "./paths.js";

export {
  authDir,
  configPath,
  logsDir,
  resolveBrainHome,
  resolveBrainPath,
  resolveScope,
} from "./paths.js";

export type BrainOptions = {
  /** Path to BRAIN_HOME (`~/brain/`). Used for config + auth lookup. */
  homeDir: string;
  rootDir: string;
  scope: string;
  /** Path to the SQLite index file. Defaults to `<rootDir>/.cache/<scope>.sqlite`. */
  dbPath?: string;
  /** When true, skip extraction-stack writers (verbatim only). Faster for read-only ops. */
  readOnly?: boolean;
  /**
   * When true, open the Memory in async write mode: `record()` runs
   * the verbatim writer synchronously and enqueues the event into
   * `<homeDir>/queue/` for the background daemon to process. The
   * slow writer chain (extractor + observer) becomes the daemon's
   * job. Producers (`brain add` / `brain remember`) and the daemon
   * itself both pass `asyncWrite: true`; tests and the eval harness
   * leave it false to keep behaviour synchronous and reproducible.
   */
  asyncWrite?: boolean;
};

export type Brain = {
  memory: Memory;
  storage: Storage;
  markdownStore: MarkdownStore;
  rootDir: string;
  scope: string;
  usage: UsageMeter;
  /**
   * The configured embedder (already cache-wrapped if the cache is
   * enabled). Exposed so callers like the daemon's file watcher can
   * pass it to `reindexFile` instead of constructing their own.
   */
  embedder: Embedder;
  /** Resolved config (provider/model/purpose snapshot at openBrain time). */
  config: BrainConfig;
  /** Runtime hosting discovered core extensions loaded for this brain. */
  extensionRuntime: BrainRuntime;
  close(): Promise<void>;
};

export async function openBrain(opts: BrainOptions): Promise<Brain> {
  mkdirSync(opts.homeDir, { recursive: true, mode: 0o700 });
  chmodSync(opts.homeDir, 0o700);
  mkdirSync(opts.rootDir, { recursive: true, mode: 0o700 });
  chmodSync(opts.rootDir, 0o700);
  const cacheDir = resolve(opts.rootDir, ".cache");
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  chmodSync(cacheDir, 0o700);
  const dbPath = opts.dbPath ?? resolve(cacheDir, `${opts.scope.replace(/\//g, "-")}.sqlite`);

  const { config } = loadBrainConfig({ homeDir: opts.homeDir });
  const authPath = authDirOf(opts.homeDir);

  // Hydrate env vars from stored api-key tokens so AI SDK's gateway-
  // routing path (`createGatewayEmbedder`, `createLLMReranker`,
  // string-id chat models) works without the user having to set
  // .env. Stored tokens win when both are present — they're the
  // brain-managed source of truth. `brain auth login --provider
  // gateway --key <key>` writes the file; this picks it up.
  hydrateEnvFromStoredKeys(config, authPath);

  // Embedding cache: opt-in via config.cache.embeddings.enabled (default
  // true). Persistent SQLite at <home>/cache/embeddings.sqlite, keyed by
  // (model_id, text), LRU-evicted past max_entries (default 5000).
  const cacheCfg = config.cache?.embeddings;
  const cacheEnabled = cacheCfg?.enabled ?? true;
  const embeddingCache: EmbeddingCache | undefined = cacheEnabled
    ? createEmbeddingCache({
        dbPath: resolve(opts.homeDir, "cache", "embeddings.sqlite"),
        ...(cacheCfg?.max_entries !== undefined ? { maxEntries: cacheCfg.max_entries } : {}),
      })
    : undefined;

  const usage = createUsageMeter();
  const extractor = buildBrainChatModel(config, "extractor", authPath);
  const observer = buildBrainChatModel(config, "observer", authPath);
  const consolidator = buildBrainChatModel(config, "consolidator", authPath);

  const embedder = buildBrainEmbedder(config, usage, embeddingCache, authPath);
  const markdownStoreForExtensions = createMarkdownStore({ rootDir: opts.rootDir });
  const storageForExtensions = createSqliteStorage({ dbPath, vectorDim: embedder.dim });
  const extensionRuntime = await loadExtensionRuntime({
    homeDir: opts.homeDir,
    rootDir: opts.rootDir,
    repository: createCoreRepository({ store: markdownStoreForExtensions, scope: opts.scope }),
    index: createCoreIndex({ storage: storageForExtensions }),
    builtins: createBuiltinWriterModules({ cacheDir, extractor, observer, usage }),
  });
  const writerModules = createWriterModules(extensionRuntime);
  const configuredWriters = enabledModuleIds(
    config.pipeline?.remember?.writers,
    DEFAULT_REMEMBER_WRITERS,
  );
  const configuredAsyncWriters = enabledModuleIds(
    config.pipeline?.remember?.async_writers,
    DEFAULT_ASYNC_WRITERS,
  );
  const syncWriterId = enabledModuleId(config.pipeline?.remember?.sync_writer, DEFAULT_SYNC_WRITER);

  // In async mode the sync writer runs immediately on record() so recall
  // sees fresh turns, while async_writers are daemon-owned slow modules.
  const writer = opts.readOnly
    ? verbatimWriter
    : createHybridWriter(
        resolveWriters(writerModules, opts.asyncWrite ? configuredAsyncWriters : configuredWriters),
      );
  const syncWriter = resolveWriter(writerModules, syncWriterId);
  const retrievalModules = enabledModuleIds(
    config.pipeline?.recall?.modules,
    DEFAULT_RECALL_MODULES,
  );
  validateRecallModules(extensionRuntime, retrievalModules);

  const consolidatorImpl = opts.readOnly
    ? undefined
    : createLlmConsolidator({
        model: consolidator.model,
        modelId: consolidator.id,
        usage,
      });

  void createContextualiser; // imported for future opt-in; off by default in CLI brain.

  const memory = await createOurMemory({
    rootDir: opts.rootDir,
    scope: opts.scope,
    dbPath,
    embedder,
    writer,
    ...(consolidatorImpl !== undefined ? { consolidator: consolidatorImpl } : {}),
    reranker: buildReranker(config, usage, authPath),
    usageMeter: usage,
    retrievalModules,
    extensionCandidateGenerators: createExtensionCandidateGenerators(
      extensionRuntime,
      retrievalModules,
    ),
    extensionRankers: createExtensionRankers(extensionRuntime, retrievalModules),
    extensionSelectors: createExtensionSelectors(extensionRuntime, retrievalModules),
    // Pass homeDir only in async mode; createOurMemory keys the queue
    // path off this and switches record()/flush() to the queued path.
    ...(opts.asyncWrite ? { homeDir: opts.homeDir, syncWriter } : {}),
  });

  // The Memory class instantiates the storage + store internally, but
  // the CLI wants direct access for `ls` / `rm` / `doctor` / daemon
  // phases. Re-instantiate them against the same paths — SQLite + the
  // filesystem are externally consistent so two handles to the same
  // files co-exist safely (single-writer at any given time, which is
  // the CLI invariant anyway).
  const storage = createSqliteStorage({ dbPath, vectorDim: embedder.dim });
  const markdownStore = createMarkdownStore({ rootDir: opts.rootDir });

  return {
    memory,
    storage,
    markdownStore,
    rootDir: opts.rootDir,
    scope: opts.scope,
    usage,
    embedder,
    config,
    extensionRuntime,
    async close() {
      await extensionRuntime.shutdown();
      await storageForExtensions.close();
      await memory.close?.();
      await storage.close();
      embeddingCache?.close();
    },
  };
}

// ─── Auth: stored api-key tokens → env vars ─────────────────────

/**
 * For each provider in config, copy any stored credential into the
 * conventional env var the AI SDK consumes (e.g. `AI_GATEWAY_API_KEY`).
 * Mostly matters for `vercel-ai-gateway` — string-id models route
 * through env-driven SDK plumbing rather than the explicit
 * `createOpenAI` path. Chat providers (`openai-compatible`, `openai`)
 * receive credentials directly via `buildChatModel`; the env hydration
 * here is the belt for string-id consumers.
 *
 * Codex stores OAuth bearers, not API keys — no env mapping.
 * `openai-compatible` has no conventional env name (server-specific);
 * stored credentials flow only via `buildChatModel`.
 */
function hydrateEnvFromStoredKeys(config: BrainConfig, authPath: string): void {
  for (const [providerKey, spec] of Object.entries(config.providers)) {
    const stored = readApiKey(authPath, providerKey);
    if (stored === null) continue;
    const envName = ENV_VAR_FOR_TYPE[spec.type];
    if (envName === undefined) continue;
    process.env[envName] = stored;
  }
}

// ─── Config → component resolution ──────────────────────────────

type WriterModuleMap = ReadonlyMap<string, Writer>;

function createWriterModules(runtime: BrainRuntime): WriterModuleMap {
  const modules = new Map<string, Writer>();
  for (const registration of runtime.registry.writers) {
    modules.set(registration.item.id, createCoreWriterAdapter(registration.item));
  }
  return modules;
}

function createBuiltinWriterModules(opts: {
  cacheDir: string;
  extractor: ResolvedChat;
  observer: ResolvedChat;
  usage: UsageMeter;
}): BrainModule[] {
  return [
    legacyWriterModule("brain/verbatim-writer", verbatimWriter, 0),
    legacyWriterModule("brain/procedural-memory", proceduralWriter, 10),
    legacyWriterModule("brain/deterministic-extraction", createDeterministicWriter(), 20),
    legacyWriterModule(
      "brain/llm-extraction",
      createExtractor({
        model: opts.extractor.model,
        modelId: opts.extractor.id,
        groupSize: 5,
        cache: extractionCache(opts.cacheDir, opts.extractor.id),
        useTextMode: false,
        usage: opts.usage,
      }),
      30,
    ),
    legacyWriterModule(
      "brain/observation-writer",
      createObservationWriter({
        model: opts.observer.model,
        modelId: opts.observer.id,
        cache: observationCache(opts.cacheDir, opts.observer.id),
        usage: opts.usage,
      }),
      40,
    ),
  ];
}

function legacyWriterModule(id: string, writer: Writer, order: number): BrainModule {
  return {
    name: id,
    version: "0.1.0",
    capabilities: ["write-repository"],
    setup(brain) {
      brain.registerWriter(
        {
          id,
          async write(ctx) {
            const bridge = ctx.metadata["brain.legacyBridge"] as LegacyWriterBridge | undefined;
            const events = bridge?.events ?? [];
            const baseOrdinal = bridge?.baseOrdinal ?? 0;
            const chunks = await writer.process(events, baseOrdinal, bridge?.context);
            return chunks.map(chunkToDocument);
          },
        },
        { order },
      );
    },
  };
}

type LegacyWriterBridge = {
  events: readonly WriteEvent[];
  baseOrdinal: number;
  context?: Parameters<Writer["process"]>[2];
};

function createCoreWriterAdapter(
  coreWriter: BrainRuntime["registry"]["writers"][number]["item"],
): Writer {
  return {
    async process(events, baseOrdinal, context): Promise<WrittenChunk[]> {
      const docs = await coreWriter.write({
        input: renderWriteEvents(events),
        documents: [],
        metadata: {
          "brain.legacyBridge": { events, baseOrdinal, context } satisfies LegacyWriterBridge,
        },
      });
      return docs.map((doc, index) => documentToChunk(doc, baseOrdinal + index));
    },
  };
}

function renderWriteEvents(events: readonly WriteEvent[]): string {
  return events
    .map((event) => {
      if (event.kind === "user-turn") return `user: ${event.text}`;
      if (event.kind === "assistant-turn") return `assistant: ${event.text}`;
      if (event.kind === "tool-call")
        return `tool: ${event.tool} args=${JSON.stringify(event.args)} result=${JSON.stringify(event.result)}`;
      return event.content;
    })
    .join("\n");
}

function chunkToDocument(chunk: WrittenChunk): MemoryDocument {
  return {
    id: chunk.id ?? crypto.randomUUID(),
    type: chunk.type,
    body: chunk.content,
    metadata: chunk.metadata ?? {},
    provenance: {
      source: "legacy-writer",
      createdAt: new Date().toISOString(),
    },
  };
}

function documentToChunk(doc: MemoryDocument, ordinal: number): WrittenChunk {
  return {
    id: doc.id,
    type: coerceMemoryType(doc.type),
    ordinal,
    content: doc.body,
    metadata: {
      ...doc.metadata,
      "brain.provenance": doc.provenance,
      ...(doc.validity !== undefined ? { "brain.validity": doc.validity } : {}),
    },
  };
}

function coerceMemoryType(type: string): WrittenChunk["type"] {
  const allowed = new Set<WrittenChunk["type"]>([
    "episodic",
    "facts",
    "preferences",
    "events",
    "decisions",
    "context",
    "observations",
    "procedural",
    "aggregates",
    "reflections",
    "patterns",
  ]);
  return allowed.has(type as WrittenChunk["type"]) ? (type as WrittenChunk["type"]) : "context";
}

const KNOWN_BUILT_IN_RECALL_MODULES = new Set<string>(BUILT_IN_RECALL_MODULE_IDS);

function validateRecallModules(runtime: BrainRuntime, ids: readonly string[]): void {
  const extensionIds = new Set([
    ...runtime.registry.candidateGenerators.map((registration) => registration.item.id),
    ...runtime.registry.rankers.map((registration) => registration.item.id),
    ...runtime.registry.selectors.map((registration) => registration.item.id),
  ]);
  const unknown = ids.filter(
    (id) => !KNOWN_BUILT_IN_RECALL_MODULES.has(id) && !extensionIds.has(id),
  );
  if (unknown.length > 0) {
    throw new Error(
      `unknown recall module id(s): ${unknown.join(", ")}. ` +
        "Register them from an extension or remove them from pipeline.recall.modules.",
    );
  }
}

function orderRegistrations<T extends { id: string }>(
  registrations: readonly { item: T; order: number }[],
  enabledIds: readonly string[],
): Array<{ item: T; order: number }> {
  const configuredOrder = new Map(enabledIds.map((id, index) => [id, index]));
  return [...registrations].sort((a, b) => {
    const ai = configuredOrder.get(a.item.id) ?? Number.MAX_SAFE_INTEGER;
    const bi = configuredOrder.get(b.item.id) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi || a.order - b.order;
  });
}

function createExtensionCandidateGenerators(
  runtime: BrainRuntime,
  enabledIds: readonly string[],
): ExtensionCandidateGenerator[] {
  const enabled = new Set(enabledIds);
  return orderRegistrations(runtime.registry.candidateGenerators, enabledIds)
    .filter((registration) => enabled.has(registration.item.id))
    .map(
      (registration): ExtensionCandidateGenerator => ({
        id: registration.item.id,
        async generate(candidates, query) {
          const generated = await registration.item.generate({
            query,
            candidates,
            selected: [],
            metadata: { "brain.legacyBridge": true },
          });
          return generated.map((candidate) => ({
            id: candidate.id,
            score: candidate.score,
            source: candidate.source,
            ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {}),
          }));
        },
      }),
    );
}

function createExtensionRankers(
  runtime: BrainRuntime,
  enabledIds: readonly string[],
): ExtensionRanker[] {
  const enabled = new Set(enabledIds);
  return orderRegistrations(runtime.registry.rankers, enabledIds)
    .filter((registration) => enabled.has(registration.item.id))
    .map(
      (registration): ExtensionRanker => ({
        id: registration.item.id,
        async rank(candidates, query) {
          const ranked = await registration.item.rank({
            query,
            candidates,
            selected: [],
            metadata: { "brain.legacyBridge": true },
          });
          return ranked.map((candidate) => ({
            id: candidate.id,
            score: candidate.score,
            source: candidate.source,
            ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {}),
          }));
        },
      }),
    );
}

function createExtensionSelectors(
  runtime: BrainRuntime,
  enabledIds: readonly string[],
): ExtensionSelector[] {
  const enabled = new Set(enabledIds);
  return orderRegistrations(runtime.registry.selectors, enabledIds)
    .filter((registration) => enabled.has(registration.item.id))
    .map(
      (registration): ExtensionSelector => ({
        id: registration.item.id,
        async select(candidates, query) {
          const selected = await registration.item.select({
            query,
            candidates,
            selected: candidates,
            metadata: { "brain.legacyBridge": true },
          });
          return selected.map((candidate) => ({
            id: candidate.id,
            score: candidate.score,
            source: candidate.source,
            ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {}),
          }));
        },
      }),
    );
}

async function loadExtensionRuntime(opts: {
  homeDir: string;
  rootDir: string;
  repository: MemoryRepository;
  index: MemoryIndex;
  builtins: BrainModule[];
}): Promise<BrainRuntime> {
  const loaded = await loadExtensions({ homeDir: opts.homeDir, rootDir: opts.rootDir });
  return createBrain({
    modules: [...opts.builtins, ...loaded.map((extension) => extension.module)],
    repository: opts.repository,
    index: opts.index,
  });
}

function resolveWriter(modules: WriterModuleMap, id: string): Writer {
  const writer = modules.get(id);
  if (writer === undefined) {
    throw new Error(`unknown remember writer module "${id}" in pipeline config`);
  }
  return writer;
}

function resolveWriters(modules: WriterModuleMap, ids: readonly string[]): Writer[] {
  return ids.map((id) => resolveWriter(modules, id));
}

export type ResolvedChat = {
  model: ReturnType<typeof buildChatModel>;
  spec: ProviderSpec;
  id: string;
};

export function resolvePurpose(
  config: BrainConfig,
  purpose: keyof BrainConfig["purposes"],
): { providerKey: string; spec: ProviderSpec; model: ModelSpec } {
  const modelKey = config.purposes[purpose];
  const model = config.models[modelKey];
  if (model === undefined) {
    throw new Error(
      `config purpose "${purpose}" -> unknown model "${modelKey}". Edit ~/brain/config.yaml.`,
    );
  }
  const providerKey = model.provider;
  const spec = config.providers[providerKey];
  if (spec === undefined) {
    throw new Error(
      `model "${modelKey}" -> unknown provider "${model.provider}". Edit ~/brain/config.yaml.`,
    );
  }
  return { providerKey, spec, model };
}

export function buildBrainChatModel(
  config: BrainConfig,
  purpose: keyof BrainConfig["purposes"],
  authPath: string,
): ResolvedChat {
  const { providerKey, spec, model } = resolvePurpose(config, purpose);
  const storedApiKey = readApiKey(authPath, providerKey);
  const chatModel = buildChatModel({
    spec,
    modelId: model.id,
    env: process.env,
    authPath,
    ...(storedApiKey !== null ? { apiKey: storedApiKey } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
  });
  return { model: chatModel, spec, id: `${spec.type}/${model.id}` };
}

export function buildBrainEmbedder(
  config: BrainConfig,
  usage: UsageMeter,
  cache: EmbeddingCache | undefined,
  authPath?: string,
): Embedder {
  const { providerKey, spec, model } = resolvePurpose(config, "embedder");
  if (model.dim === undefined) {
    throw new Error(
      `embedder model "${config.purposes.embedder}" must declare \`dim\` in ~/brain/config.yaml.`,
    );
  }

  let inner: Embedder;
  switch (spec.type) {
    case "vercel-ai-gateway":
      inner = createGatewayEmbedder({ model: model.id, dim: model.dim, usage });
      break;

    case "openai-compatible": {
      // Any OpenAI-compatible server (LM Studio, Ollama, vLLM).
      // Stored credential at <home>/auth/<providerKey>.json wins;
      // unauthenticated servers (LM Studio default, Ollama) get a
      // dummy key that the SDK passes through harmlessly.
      const stored = authPath !== undefined ? readApiKey(authPath, providerKey) : null;
      inner = createLocalEmbedder({
        model: model.id,
        dim: model.dim,
        ...(spec.base_url !== undefined ? { baseURL: spec.base_url } : {}),
        ...(stored !== null ? { apiKey: stored } : {}),
      });
      break;
    }

    default:
      throw new Error(
        `embedder purpose doesn't support provider type "${spec.type}". Codex / direct OpenAI / ` +
          "Anthropic don't expose embedders. Use vercel-ai-gateway, local, or openai-compatible.",
      );
  }

  return cache !== undefined ? withEmbeddingCache(inner, cache) : inner;
}

function buildReranker(config: BrainConfig, usage: UsageMeter, authPath: string) {
  const { providerKey, spec, model } = resolvePurpose(config, "reranker");
  if (spec.type === "local-heuristic") {
    // Sub-ms local reranker — MMR over embeddings + hard near-dup
    // suppression. No LLM call; doesn't touch `usage`. The model
    // entry's `id` is ignored.
    return createHeuristicReranker();
  }
  // All LLM-backed rerankers (gateway, codex, openai-direct,
  // openai-compatible, local) go through buildChatModel, which
  // returns a string id for the gateway and a LanguageModel for
  // everything else. createLLMReranker (named for historical
  // reasons — should rename to createLLMReranker) accepts both.
  const storedApiKey = readApiKey(authPath, providerKey);
  const chatModel = buildChatModel({
    spec,
    modelId: model.id,
    env: process.env,
    authPath,
    ...(storedApiKey !== null ? { apiKey: storedApiKey } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
  });
  return createLLMReranker({
    model: chatModel,
    windowK: 20,
    usage,
    usageId: `${spec.type}/${model.id}`,
  });
}

// ─── Caches keyed by resolved model id ──────────────────────────

function extractionCache(cacheDir: string, modelId: string): FactCache {
  return createFactCache({
    cacheDir: resolve(cacheDir, "extraction"),
    cacheKey: `${modelId}:v1`,
  });
}

function observationCache(cacheDir: string, modelId: string) {
  return createObservationCache({
    cacheDir: resolve(cacheDir, "observation"),
    cacheKey: `${modelId}:v2`,
  });
}
