import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  Memory,
  MemoryEvent,
  MemoryUsageReport,
  RetrievalInput,
  RetrievalResult,
} from "@ai-assistant/contracts";
import { nanoid } from "nanoid";
import type { Consolidator } from "./consolidate/index.js";
import type { Embedder } from "./embedding/index.js";
import {
  createSlugResolver,
  extractFrontmatterEdges,
  extractPageEdges,
  type SlugResolver,
} from "./graph/index.js";
import { enqueue as enqueueQueueItem, type QueueItem, stats as queueStats } from "./queue/index.js";
import { redact, redactEvent } from "./redact.js";
import {
  EntityIndex,
  type FallbackQueryRewriter,
  heuristicFallbackRewriter,
  type QueryExpander,
  RecallModulePlan,
  type Reranker,
  runRecallPipeline,
} from "./retrieval/index.js";
import type { Frontmatter } from "./storage/frontmatter.js";
import { createMarkdownStore, type MarkdownStore } from "./storage/markdown-store.js";
import { deriveOkfTitle } from "./storage/okf.js";
import { createSqliteStorage, type Edge, hashContent, type Storage } from "./storage/sqlite.js";
import type { Chunk } from "./storage/types.js";
import type { UsageMeter } from "./usage.js";
import { verbatimWriter, type WriteEvent, type Writer, type WrittenChunk } from "./write/index.js";

export type ExtensionRecallCandidate = {
  id: string;
  score: number;
  source: string;
  metadata?: Record<string, unknown>;
};

export type ExtensionCandidateGenerator = {
  id: string;
  generate(
    candidates: ExtensionRecallCandidate[],
    query: string,
  ): Promise<ExtensionRecallCandidate[]> | ExtensionRecallCandidate[];
};

export type ExtensionRanker = {
  id: string;
  rank(
    candidates: ExtensionRecallCandidate[],
    query: string,
  ): Promise<ExtensionRecallCandidate[]> | ExtensionRecallCandidate[];
};

export type ExtensionSelector = {
  id: string;
  select(
    candidates: ExtensionRecallCandidate[],
    query: string,
  ): Promise<ExtensionRecallCandidate[]> | ExtensionRecallCandidate[];
};

export type CreateOurMemoryOptions = {
  /**
   * Root directory for the on-disk markdown store. Markdown files at
   * `<rootDir>/<scope>/<type>/<slug>.md` are the source of truth;
   * SQLite is a derived index/cache. Required.
   */
  rootDir: string;
  /**
   * Namespace within the root — e.g. `"user/joe"`, `"project/alpha"`,
   * or a per-question id during eval. Files for this Memory live at
   * `<rootDir>/<scope>/<type>/<slug>.md`.
   */
  scope: string;
  /** SQLite filesystem path or `:memory:` (default). */
  dbPath?: string;
  /** Default top-K for retrieval when callers don't set a budget. */
  defaultTopK?: number;
  /** Single embedder. With this, retrieval is hybrid BM25 + vector via RRF. */
  embedder?: Embedder;
  /**
   * Multiple embedders for ensemble retrieval. Each embedder gets its own
   * SQLite storage (sized to its dim). Chunks share ids across storages
   * so RRF can fuse hits cleanly. Mutually exclusive with `embedder`.
   */
  embedders?: Embedder[];
  /**
   * Per-embedder leg weights for the ensemble. Multiplies the intent's
   * vector weight on that leg. Defaults to 1.0 per embedder. Useful when
   * one embedder is empirically stronger than another on the workload —
   * e.g. `embedderWeights: [1.0, 0.5]` for Gemini-strong + Nomic-half.
   */
  embedderWeights?: number[];
  /** Optional cross-encoder reranker. Runs after RRF fusion. */
  reranker?: Reranker;
  /** Write strategy. Defaults to `verbatimWriter` (one chunk per turn). */
  writer?: Writer;
  /** Vector candidate fan-out per leg. Default 50. */
  candidateK?: number;
  /**
   * Optional query expander (RAG-Fusion). When set, each retrieve()
   * call rewrites the user query into N variants, retrieves for each,
   * and RRF-fuses all the resulting candidate lists. Helps when the
   * same answer is phrased differently across the haystack — common in
   * multi-session aggregation questions.
   */
  queryExpander?: QueryExpander;
  fallbackQueryRewriter?: FallbackQueryRewriter;
  /**
   * topK override for queries whose intent has `pathMultipliers` set
   * (extraction-stack temporal/factoid/preference queries). When unset,
   * the normal `topK` resolution applies. Setting this lets extraction
   * stacks surface more candidates per multi-event query (where the
   * actor needs to count or compare) without bloating verbatim-only
   * stacks where path multipliers no-op.
   */
  pathBoostTopK?: number;
  /**
   * Optional write-time consolidator. After the writer produces chunks
   * for a flush, the consolidator runs over them and emits aggregate
   * chunks (at `aggregate-*` paths) summarising counts/totals/orderings
   * across related facts. Targets multi-session counting questions
   * where top-K can't surface every relevant event.
   */
  consolidator?: Consolidator;
  /**
   * Optional shared usage meter. When set, callers wire the same
   * meter into every LLM-using component they pass in (extractor,
   * observer, consolidator, contextualiser, reranker, expander,
   * embedder); the resulting `Memory.usage()` snapshot then reports
   * token spend per component. Eval harness uses this to attribute
   * per-question cost to extraction vs reranking vs embedding etc.
   */
  usageMeter?: UsageMeter;
  /**
   * BRAIN_HOME path. When set, OurMemory runs in **async write mode**:
   * each `record()` runs `syncWriter` synchronously (verbatim chunk
   * lands in BM25 + vector indexes immediately) and enqueues the event
   * to `<homeDir>/queue/` for a daemon worker to run the slow `writer`
   * chain. `flush()` polls until the queue drains for this scope.
   *
   * When unset, OurMemory runs in legacy synchronous mode: `record()`
   * just buffers and `flush()` (called explicitly or implicitly via
   * `retrieve()`) runs the full `writer` chain. Eval baselines and
   * test harnesses use sync mode for reproducibility.
   */
  homeDir?: string;
  /**
   * Cheap, synchronous writer that runs on every `record()` in async
   * mode. Defaults to `verbatimWriter` (one chunk per event, no LLM).
   * Ignored in sync mode. The `writer` configured separately is
   * what the daemon runs against queued items, so it should NOT
   * include the verbatim writer when async mode is on (otherwise
   * verbatim chunks would land twice — once sync, once async).
   */
  syncWriter?: Writer;
  /** Ordered recall module ids. Defaults preserve the historical retrieval stack. */
  retrievalModules?: readonly string[];
  /** Candidate generators registered by external core extensions and enabled from recall pipeline config. */
  extensionCandidateGenerators?: readonly ExtensionCandidateGenerator[];
  /** Rankers registered by external core extensions and enabled from recall pipeline config. */
  extensionRankers?: readonly ExtensionRanker[];
  /** Selectors registered by external core extensions and enabled from recall pipeline config. */
  extensionSelectors?: readonly ExtensionSelector[];
  /**
   * Optional observability hook fired once per stage transition inside
   * `runWriterPipeline`. Used by the daemon to answer "what stage was
   * this doc on when it failed?" without rebuilding the pipeline as a
   * full state machine (BRAIN-180). A `done` event fires after a
   * successful completion; on throw, the most recent stage event is
   * the one that crashed.
   */
  onWritePipelineStage?: WritePipelineStageHook;
};

/** Stages emitted by `runWriterPipeline` for diagnostics. */
export type WritePipelineStage =
  | "writer"
  | "dedup"
  | "consolidate"
  | "persist"
  | "index"
  | "edge"
  | "done";

export type WritePipelineStageEvent = {
  readonly stage: WritePipelineStage;
  /** Items being passed into this stage. */
  readonly count: number;
};

export type WritePipelineStageHook = (event: WritePipelineStageEvent) => void;

const DEFAULT_TOP_K = 5;
const DEFAULT_CANDIDATE_K = 50;
const DEFAULT_RETRIEVAL_MODULES = [
  "brain/temporal-expansion",
  "brain/intent-planner",
  "brain/bm25",
  "brain/vector",
  "brain/entity",
  "brain/fallback-query-rewrite",
  "brain/rrf",
  "brain/cosine-rescore",
  "brain/type-boost",
  "brain/temporal-decay",
  "brain/status-penalty",
  "brain/assistant-reference-boost",
  "brain/backlink-boost",
  "brain/authority-boost",
  "brain/usage-boost",
  "brain/reranker",
  "brain/retrieval-log",
] as const;

export async function createOurMemory(opts: CreateOurMemoryOptions): Promise<Memory> {
  if (opts.embedder !== undefined && opts.embedders !== undefined) {
    throw new Error("createOurMemory: pass either `embedder` or `embedders`, not both");
  }
  const embedders = opts.embedders ?? (opts.embedder !== undefined ? [opts.embedder] : []);

  // One storage per embedder; one bare storage if no embedders. Chunk ids
  // are generated once at flush time and shared across all storages so
  // RRF fusion can match by id.
  const storages: Storage[] =
    embedders.length > 0
      ? embedders.map((e) =>
          createSqliteStorage({
            ...(opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {}),
            vectorDim: e.dim,
          }),
        )
      : [
          createSqliteStorage({
            ...(opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {}),
          }),
        ];

  const embedderWeights = opts.embedderWeights ?? embedders.map(() => 1.0);
  if (embedderWeights.length !== embedders.length) {
    throw new Error("createOurMemory: `embedderWeights` length must match `embedders` length");
  }
  const markdownStore = createMarkdownStore({ rootDir: opts.rootDir });
  return new OurMemory(
    markdownStore,
    opts.scope,
    storages,
    embedders,
    embedderWeights,
    opts.defaultTopK ?? DEFAULT_TOP_K,
    opts.candidateK ?? DEFAULT_CANDIDATE_K,
    opts.reranker,
    opts.writer ?? verbatimWriter,
    opts.queryExpander,
    opts.fallbackQueryRewriter ?? heuristicFallbackRewriter,
    opts.pathBoostTopK,
    opts.consolidator,
    opts.usageMeter,
    opts.homeDir,
    opts.syncWriter ?? verbatimWriter,
    opts.retrievalModules,
    opts.extensionCandidateGenerators ?? [],
    opts.extensionRankers ?? [],
    opts.extensionSelectors ?? [],
    opts.onWritePipelineStage,
  );
}

class OurMemory implements Memory {
  private writeBuffer: WriteEvent[] = [];
  private flushedCount = 0;
  // In-memory entity index (Lever C from research/jeffs-brain). Maps
  // canonical entity → chunk ids. Populated at flush time from
  // extracted-fact chunks' metadata.entities. Queried at retrieve
  // time to surface chunks tagged with entities the query mentions.
  private readonly entityIndex = new EntityIndex();
  // Wikilink slug → chunkId map. Populated alongside the entity index
  // so wikilinks materialise as chunk-to-chunk edges instead of
  // free-text entity refs.
  private readonly slugResolver: SlugResolver = createSlugResolver();

  constructor(
    private readonly markdownStore: MarkdownStore,
    private readonly scope: string,
    private readonly storages: Storage[],
    private readonly embedders: Embedder[],
    private readonly embedderWeights: number[],
    private readonly defaultTopK: number,
    private readonly candidateK: number,
    private readonly reranker: Reranker | undefined,
    private readonly writer: Writer,
    private readonly queryExpander: QueryExpander | undefined,
    private readonly fallbackQueryRewriter: FallbackQueryRewriter | undefined,
    private readonly pathBoostTopK: number | undefined,
    private readonly consolidator: Consolidator | undefined,
    private readonly usageMeter: UsageMeter | undefined,
    private readonly homeDir: string | undefined,
    private readonly syncWriter: Writer,
    retrievalModules: readonly string[] | undefined,
    private readonly extensionCandidateGenerators: readonly ExtensionCandidateGenerator[],
    private readonly extensionRankers: readonly ExtensionRanker[],
    private readonly extensionSelectors: readonly ExtensionSelector[],
    private readonly onWritePipelineStage: WritePipelineStageHook | undefined,
  ) {
    this.retrievalModulePlan = new RecallModulePlan(retrievalModules ?? DEFAULT_RETRIEVAL_MODULES);
  }

  private readonly retrievalModulePlan: RecallModulePlan;

  private recallModuleEnabled(id: string): boolean {
    return this.retrievalModulePlan.isEnabled(id);
  }

  /** True when async write mode is active (homeDir + queue configured). */
  private get asyncMode(): boolean {
    return this.homeDir !== undefined;
  }

  usage(): MemoryUsageReport {
    return (
      this.usageMeter?.snapshot() ?? {
        entries: [],
        totals: { inputTokens: 0, outputTokens: 0, calls: 0 },
      }
    );
  }

  async record(event: MemoryEvent): Promise<void> {
    // Redact secrets at the single write-path chokepoint — before the verbatim
    // write, before the event is enqueued to disk, and before the daemon's
    // extraction model ever sees it. Everything downstream handles scrubbed text.
    const safe = redactEvent(event);
    const writeEvent = toWriteEvent(safe);
    if (writeEvent === null) return;

    if (this.asyncMode && this.homeDir !== undefined) {
      // Async mode: run verbatim writer immediately so BM25 + vector
      // can find this turn straight away, then enqueue the event for
      // a daemon worker to run the slow writer chain (extractor,
      // observer, consolidator, graph).
      await this.runWriterPipeline(this.syncWriter, [writeEvent]);
      await enqueueQueueItem({
        homeDir: this.homeDir,
        scope: this.scope,
        event: safe,
      });
      return;
    }

    // Sync mode: legacy behaviour. Buffer; flush() runs the full
    // writer chain on the next retrieve() (or explicit flush()).
    this.writeBuffer.push(writeEvent);
  }

  /**
   * Run the slow (queued) writer chain on a single event the daemon
   * has claimed from the queue. This is the async-mode counterpart to
   * the sync-mode `flush()` of the in-memory write buffer.
   *
   * Persistence, embedding, indexing, entity-index updates, slug
   * resolution and graph edges all run as if the event had gone
   * through the legacy synchronous path — only the *trigger* is
   * different (queued claim instead of in-process buffer).
   */
  async processQueuedEvent(event: MemoryEvent): Promise<void> {
    // Defence in depth: items enqueued via `record()` are already scrubbed, but
    // re-redact (idempotent) so any item reaching the slow chain by another path
    // is still covered before it hits the extraction model.
    const writeEvent = toWriteEvent(redactEvent(event));
    if (writeEvent === null) return;
    await this.runWriterPipeline(this.writer, [writeEvent]);
  }

  /** Convenience wrapper for daemon callers that already have a `QueueItem`. */
  async processQueuedItem(item: QueueItem): Promise<void> {
    await this.processQueuedEvent(item.event);
  }

  async retrieve(input: RetrievalInput): Promise<RetrievalResult> {
    if (!this.asyncMode) {
      await this.flush();
    }

    const result = await runRecallPipeline({
      input,
      storages: this.storages,
      embedders: this.embedders,
      embedderWeights: this.embedderWeights,
      defaultTopK: this.defaultTopK,
      candidateK: this.candidateK,
      entityIndex: this.entityIndex,
      recallModuleEnabled: (id) => this.recallModuleEnabled(id),
      ...(this.queryExpander !== undefined ? { queryExpander: this.queryExpander } : {}),
      ...(this.fallbackQueryRewriter !== undefined
        ? { fallbackQueryRewriter: this.fallbackQueryRewriter }
        : {}),
      ...(this.pathBoostTopK !== undefined ? { pathBoostTopK: this.pathBoostTopK } : {}),
      ...(this.reranker !== undefined ? { reranker: this.reranker } : {}),
      extensionCandidateGenerators: this.extensionCandidateGenerators,
      extensionRankers: this.extensionRankers,
      extensionSelectors: this.extensionSelectors,
    });

    if (this.recallModuleEnabled("brain/retrieval-log")) {
      await this.logRetrievalImpression(input.query, result);
    }
    return result;
  }

  private async logRetrievalImpression(query: string, result: RetrievalResult): Promise<void> {
    try {
      const path = resolve(
        this.markdownStore.rootDir,
        ".cache",
        `${this.scope.replace(/\//g, "-")}.retrievals.jsonl`,
      );
      const logDir = dirname(path);
      await mkdir(logDir, { recursive: true, mode: 0o700 });
      await chmod(logDir, 0o700).catch(() => undefined);
      await appendFile(
        path,
        `${JSON.stringify({
          at: new Date().toISOString(),
          scope: this.scope,
          query: redact(query),
          itemIds: result.items.map((i) => i.id),
          scores: result.items.map((i) => i.score),
          diagnostics: result.diagnostics,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await chmod(path, 0o600).catch(() => undefined);
    } catch {
      // Retrieval logging is observational only; never fail recall.
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.storages.map((s) => s.close()));
  }

  /**
   * Drain pending work owned by this Memory.
   *
   * Sync mode: process the in-memory write buffer through the full
   * writer chain (extractor + observer + consolidator + ...) and
   * persist outputs. The same path retrieve() implicitly takes.
   *
   * Async mode: poll the durable queue for this scope until depth
   * reaches 0 or `timeoutMs` elapses. Does NOT itself drain the
   * queue; the daemon worker is the one that runs the writer chain
   * on queued items. flush() just blocks until that work is done so
   * callers (eval harness, `brain flush --wait`) can take a
   * point-in-time consistent view.
   */
  async flush(opts?: { timeoutMs?: number }): Promise<void> {
    if (this.asyncMode && this.homeDir !== undefined) {
      await this.waitForQueueDrain(this.homeDir, opts?.timeoutMs);
      return;
    }
    if (this.writeBuffer.length === 0) return;
    const buffer = this.writeBuffer;
    this.writeBuffer = [];
    await this.runWriterPipeline(this.writer, buffer);
  }

  /**
   * Block until the queue has no pending or in-flight items for this
   * scope. Polls every 100ms. Throws on timeout so callers can
   * distinguish "drained" from "gave up waiting".
   */
  private async waitForQueueDrain(homeDir: string, timeoutMs?: number): Promise<void> {
    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
    for (;;) {
      const s = await queueStats({ homeDir });
      if (s.pending === 0 && s.inFlight === 0) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `Memory.flush: queue did not drain within ${timeoutMs}ms ` +
            `(pending=${s.pending} inFlight=${s.inFlight})`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * The writer-pipeline body, factored out of `flush()` so the async
   * `record()` path and the daemon worker (`processQueuedEvent`) can
   * call it on individual events without going through the in-memory
   * buffer.
   *
   * Side effects on `this`: bumps `flushedCount`, populates
   * `entityIndex` and `slugResolver`. Safe to call concurrently from
   * sync flush + async paths because the index data structures are
   * append-only per call (no rebalancing across calls).
   */
  private async runWriterPipeline(writer: Writer, events: readonly WriteEvent[]): Promise<void> {
    if (events.length === 0) return;
    // BRAIN-180 observability: emit a stage event at every transition
    // so the daemon can answer "what stage was this doc on when it
    // failed?" The most recently emitted stage on throw is the one
    // that crashed. `done` fires only on full success.
    this.emitStage("writer", events.length);
    const writerOutput = await writer.process(events, this.flushedCount, {
      existingMemories: this.findExistingMemoryPreviews(events),
    });
    if (writerOutput.length === 0) return;

    // Write-time content-hash dedup. If the writer emits a chunk
    // whose body matches an existing live chunk's hash (or matches
    // another chunk in this same flush), drop it. The natural case:
    // `brain add "I love pizza"` followed by `brain add "I love
    // pizza"` produces two writer outputs with the same body — we
    // want one chunk on disk, not two. Two real conversational
    // turns of the same words have different surrounding context
    // (timestamps, role markers) baked into the body so they hash
    // differently and stay distinct.
    //
    // Run before the consolidator so we don't waste an LLM call
    // summarising chunks we're about to drop.
    this.emitStage("dedup", writerOutput.length);
    const seenHashes = new Set<string>();
    const dedupedWriterOutput = writerOutput.filter((c) => {
      const hash = hashContent(c.content);
      if (seenHashes.has(hash)) return false;
      seenHashes.add(hash);
      // Check across ALL configured stores; if any has a live chunk
      // with this hash, skip the write everywhere.
      for (const s of this.storages) {
        if (s !== undefined && s.findChunkIdByContentHash(hash) !== undefined) {
          return false;
        }
      }
      return true;
    });
    if (dedupedWriterOutput.length === 0) return;

    // Optional consolidation pass — runs over the writer's output and
    // emits aggregate chunks (`aggregates/*`) summarising related facts.
    // Aggregates land in the same store with their own embeddings,
    // retrievable like any other chunk.
    this.emitStage("consolidate", dedupedWriterOutput.length);
    const consolidated =
      this.consolidator !== undefined
        ? await this.consolidator.consolidate(
            dedupedWriterOutput,
            this.flushedCount + dedupedWriterOutput.length,
          )
        : [];
    const written = [...dedupedWriterOutput, ...consolidated];

    const ids = written.map((c) => c.id ?? nanoid());

    // Persist each chunk to disk via the markdown store. The store
    // owns slug generation + collision resolution; we get back the
    // absolute file path which becomes `Chunk.path` in the index.
    this.emitStage("persist", written.length);
    const filePaths = await Promise.all(
      written.map((c, i) => this.persistChunk(c, ids[i] as string)),
    );

    const texts = written.map((c) => c.content);

    const allEmbeddings: (Float32Array[] | undefined)[] =
      this.embedders.length > 0
        ? await Promise.all(this.embedders.map((e) => e.embed(texts)))
        : [undefined];

    // Index into SQLite. The body content is stored alongside the
    // file path so retrieval doesn't need a disk read per hit; on
    // file edits the index can be patched against the disk source.
    this.emitStage("index", written.length);
    for (let s = 0; s < this.storages.length; s++) {
      const storage = this.storages[s];
      if (storage === undefined) continue;
      const embeddings = allEmbeddings[s];
      const chunks: Chunk[] = written.map((c, i) => {
        const embedding = embeddings?.[i];
        return {
          id: ids[i] as string,
          path: filePaths[i] as string,
          type: c.type,
          ordinal: c.ordinal,
          content: c.content,
          ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
          ...(embedding !== undefined ? { embedding } : {}),
        };
      });
      storage.upsertChunks(chunks);
    }

    // Mark superseded source memories now that new ids exist.
    for (let i = 0; i < written.length; i++) {
      const supersedes = written[i]?.metadata?.supersedes;
      const id = ids[i];
      if (typeof supersedes === "string" && id !== undefined) {
        for (const storage of this.storages) storage.markSuperseded(supersedes, id);
      }
    }

    // Populate entity index + slug resolver from this flush's chunks.
    // Run BEFORE edge extraction so wikilinks pointing to chunks
    // emitted in the same flush resolve to ids rather than free-text
    // entity edges.
    const slugFor = (filePath: string): string => {
      const name = filePath.split("/").pop() ?? "";
      return name.replace(/\.md$/, "");
    };
    for (let i = 0; i < written.length; i++) {
      const c = written[i];
      const id = ids[i];
      if (c === undefined || id === undefined) continue;
      const entities = c.metadata?.entities;
      const stringEntities = Array.isArray(entities)
        ? entities.filter((e): e is string => typeof e === "string")
        : [];
      if (stringEntities.length > 0) this.entityIndex.add(id, stringEntities);
      for (const storage of this.storages) storage.upsertChunkEntities(id, stringEntities);
      const filePath = filePaths[i];
      if (typeof filePath === "string") {
        const slug = slugFor(filePath);
        this.slugResolver.register(slug, id);
        for (const storage of this.storages) storage.upsertSlug(this.scope, slug, id);
      }
    }

    // Graph layer: extract typed edges per chunk (port of GBrain).
    // Per-chunk body + frontmatter contributes both entity-mention
    // edges (with verb-inferred link types) and frontmatter-derived
    // edges (one per field-rule × value). All edges flush in one
    // SQLite transaction; deduped at the unique index.
    const edges: Edge[] = [];
    for (let i = 0; i < written.length; i++) {
      const c = written[i];
      const id = ids[i];
      if (c === undefined || id === undefined) continue;
      const md = c.metadata ?? {};
      const stringEntities = Array.isArray(md.entities)
        ? md.entities.filter((e): e is string => typeof e === "string")
        : [];
      const stringTopics = Array.isArray(md.topics)
        ? md.topics.filter((t): t is string => typeof t === "string")
        : [];
      edges.push(
        ...extractPageEdges({
          fromChunkId: id,
          body: c.content,
          type: c.type,
          entities: stringEntities,
          resolveSlug: (slug, scope) =>
            this.slugResolver.resolve(slug, scope) ??
            this.storages[0]?.resolveSlug(scope ?? this.scope, slug),
        }),
      );
      const fm: Frontmatter = {
        ...(stringEntities.length > 0 ? { entities: stringEntities } : {}),
        ...(stringTopics.length > 0 ? { topics: stringTopics } : {}),
      };
      if (Object.keys(fm).length > 0) {
        edges.push(
          ...extractFrontmatterEdges({
            fromChunkId: id,
            frontmatter: fm,
            resolveSlug: (slug, scope) =>
              this.slugResolver.resolve(slug, scope) ??
              this.storages[0]?.resolveSlug(scope ?? this.scope, slug),
          }),
        );
      }
    }
    this.emitStage("edge", edges.length);
    if (edges.length > 0) {
      for (const storage of this.storages) storage.upsertEdges(edges);
    }
    this.flushedCount += written.length;
    this.emitStage("done", written.length);
  }

  private emitStage(stage: WritePipelineStage, count: number): void {
    if (this.onWritePipelineStage === undefined) return;
    try {
      this.onWritePipelineStage({ stage, count });
    } catch {
      // Observability is best-effort; a buggy hook must never derail
      // the pipeline. The stage transition has already happened.
    }
  }

  private findExistingMemoryPreviews(events: readonly WriteEvent[]) {
    const primary = this.storages[0];
    if (primary === undefined || primary.size() === 0) return [];
    const query = events
      .map((e) =>
        e.kind === "ingested-item"
          ? e.content
          : e.kind === "tool-call"
            ? `${e.tool} ${JSON.stringify(e.args)} ${JSON.stringify(e.result)}`
            : e.text,
      )
      .join("\n")
      .slice(0, 2000);
    if (query.trim() === "") return [];
    const seen = new Set<string>();
    const previews = [];
    for (const hit of primary.searchBM25(query, 12)) {
      if (seen.has(hit.chunk.id)) continue;
      seen.add(hit.chunk.id);
      previews.push({
        id: hit.chunk.id,
        path: hit.chunk.path,
        type: hit.chunk.type,
        content: hit.chunk.content,
      });
    }
    return previews;
  }

  private async persistChunk(c: WrittenChunk, id: string): Promise<string> {
    const md = c.metadata ?? {};
    const entityList = Array.isArray(md.entities)
      ? md.entities.filter((e): e is string => typeof e === "string")
      : undefined;
    const topicList = Array.isArray(md.topics)
      ? md.topics.filter((t): t is string => typeof t === "string")
      : undefined;
    const sourceTitle = typeof md.sourceTitle === "string" ? md.sourceTitle : undefined;
    const recordedAt = typeof md.recordedAt === "string" ? md.recordedAt : undefined;

    // OKF (Open Knowledge Format) frontmatter. The core fields lead — `type`
    // (required) plus `title`, `tags` and `timestamp` — so files are
    // OKF-conformant. The richer native keys (id/recordedAt/topics/authority/…)
    // follow as OKF extension keys; the SQLite index still reads those, so the
    // projection is purely additive and leaves retrieval untouched. `tags` and
    // `timestamp` mirror the canonical `topics`/`recordedAt`.
    const fm: Frontmatter = { type: c.type };
    fm.title = deriveOkfTitle(c.content, sourceTitle);
    if (topicList && topicList.length > 0) fm.tags = topicList;
    if (recordedAt !== undefined) fm.timestamp = recordedAt;

    // Native / extension keys.
    fm.id = id;
    if (recordedAt !== undefined) fm.recordedAt = recordedAt;
    if (entityList !== undefined) fm.entities = entityList;
    if (topicList !== undefined) fm.topics = topicList;
    if (typeof md.priority === "string") fm.priority = md.priority;
    if (typeof md.factType === "string") fm.factType = md.factType;
    if (typeof md.kind === "string") fm.kind = md.kind;
    // Provenance: each writer stamps its own authority (extractor →
    // 'extracted', observer → 'observed', consolidator → 'consolidated',
    // verbatim/episodic → 'observed', daemon-emitted → 'inferred').
    // Manual edits land via the file-watcher, which promotes to
    // 'manual' when frontmatter doesn't already specify a higher
    // authority. Default for chunks without an explicit authority is
    // 'extracted' (×1.0) so legacy rows aren't penalised.
    const authority = typeof md.authority === "string" ? md.authority : authorityForType(c.type);
    if (authority !== undefined) fm.authority = authority;
    if (typeof md.confidence === "number") fm.confidence = md.confidence;
    if (typeof md.status === "string") fm.status = md.status;
    if (typeof md.supersedes === "string") fm.supersedes = md.supersedes;
    if (typeof md.extractedBy === "string") fm.extractedBy = md.extractedBy;
    if (typeof md.extractorModel === "string") fm.extractorModel = md.extractorModel;
    if (typeof md.extractorPromptVersion === "string")
      fm.extractorPromptVersion = md.extractorPromptVersion;
    if (typeof md.sourceKind === "string") fm.sourceKind = md.sourceKind;
    if (typeof md.sourceUri === "string") fm.sourceUri = md.sourceUri;
    if (typeof md.sourceTitle === "string") fm.sourceTitle = md.sourceTitle;
    if (typeof md.sourceInstanceId === "string") fm.sourceInstanceId = md.sourceInstanceId;
    if (typeof md.sourceExternalId === "string") fm.sourceExternalId = md.sourceExternalId;
    if (Array.isArray(md.derivedFrom)) {
      fm.derivedFrom = md.derivedFrom.filter((d): d is string => typeof d === "string");
    }
    const result = await this.markdownStore.write({
      scope: this.scope,
      type: c.type,
      body: c.content,
      frontmatter: fm,
      ...(typeof md.recordedAt === "string" ? { recordedAt: md.recordedAt } : {}),
    });
    return result.filePath;
  }
}

/**
 * Translate a `MemoryEvent` (the public contract type) into the
 * internal `WriteEvent` the writer chain consumes. Returns `null` for
 * events the writer chain doesn't represent (currently `tool-call`,
 * which is observed in the actor loop but not persisted as memory).
 */
function toWriteEvent(event: MemoryEvent): WriteEvent | null {
  if (event.kind === "user-turn") {
    return {
      kind: "user-turn",
      text: event.text,
      ...(event.recordedAt !== undefined ? { recordedAt: event.recordedAt } : {}),
    };
  }
  if (event.kind === "assistant-turn") {
    return {
      kind: "assistant-turn",
      text: event.text,
      ...(event.recordedAt !== undefined ? { recordedAt: event.recordedAt } : {}),
    };
  }
  if (event.kind === "ingested-item") {
    return {
      kind: "ingested-item",
      content: event.content,
      ...(event.recordedAt !== undefined ? { recordedAt: event.recordedAt } : {}),
      source: event.source,
    };
  }
  if (event.kind === "tool-call") {
    return {
      kind: "tool-call",
      tool: event.tool,
      args: event.args,
      result: event.result,
    };
  }
  return null;
}

/**
 * Default authority per memory category. Writers can override by
 * setting `metadata.authority` explicitly.
 */
function authorityForType(type: string): string | undefined {
  switch (type) {
    case "facts":
    case "preferences":
    case "events":
    case "decisions":
    case "context":
      return "extracted";
    case "observations":
      return "observed";
    case "aggregates":
    case "reflections":
    case "patterns":
      return "consolidated";
    case "procedural":
      return "observed";
    case "episodic":
      return "observed";
    default:
      return undefined;
  }
}
