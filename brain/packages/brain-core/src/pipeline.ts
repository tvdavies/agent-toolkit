import type { ModuleRegistry } from "./registry.js";
import type { MemoryIndex, MemoryRepository } from "./stores.js";
import type { Candidate, MemoryDocument } from "./types.js";

export interface RememberInput {
  input: string;
  metadata?: Record<string, unknown>;
}

export interface RememberResult {
  documents: MemoryDocument[];
}

export interface RecallInput {
  query: string;
  metadata?: Record<string, unknown>;
  limit?: number;
}

export interface RecallResult {
  candidates: Candidate[];
}

/** Execute the staged remember lifecycle and persist/index documents returned by writers and extractors. */
export async function runRemember(
  registry: ModuleRegistry,
  repository: MemoryRepository,
  index: MemoryIndex,
  input: RememberInput,
): Promise<RememberResult> {
  const ctx = {
    input: input.input,
    documents: [] as MemoryDocument[],
    metadata: input.metadata ?? {},
  };
  await registry.emit("remember:start", ctx);
  await registry.emit("remember:event", ctx);
  await registry.emit("extract:before", ctx);

  for (const registration of registry.writers)
    ctx.documents.push(...(await registration.item.write(ctx)));
  for (const registration of registry.extractors)
    ctx.documents.push(...(await registration.item.extract(ctx)));

  await registry.emit("extract:after", ctx);
  await registry.emit("persist:before", ctx);
  for (const doc of ctx.documents) {
    await repository.put(doc);
    await index.upsert(doc);
  }
  await registry.emit("persist:after", ctx);
  return { documents: ctx.documents };
}

/** Execute the staged recall lifecycle: generate candidates, rank them, select final results. */
export async function runRecall(
  registry: ModuleRegistry,
  input: RecallInput,
): Promise<RecallResult> {
  const ctx = {
    query: input.query,
    candidates: [] as Candidate[],
    selected: [] as Candidate[],
    metadata: input.metadata ?? {},
  };
  await registry.emit("recall:start", ctx);
  await registry.emit("query:prepare", ctx);
  await registry.emit("candidates:generate", ctx);

  for (const registration of registry.candidateGenerators)
    ctx.candidates.push(...(await registration.item.generate(ctx)));

  await registry.emit("candidates:fuse", ctx);
  for (const registration of registry.rankers) ctx.candidates = await registration.item.rank(ctx);

  await registry.emit("rank:apply", ctx);
  ctx.selected = ctx.candidates.slice(0, input.limit ?? ctx.candidates.length);
  for (const registration of registry.selectors) ctx.selected = await registration.item.select(ctx);

  await registry.emit("select:apply", ctx);
  await registry.emit("recall:end", ctx);
  return { candidates: ctx.selected };
}
