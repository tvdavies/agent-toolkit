import type { RetrievalInput } from "@ai-assistant/contracts";
import type { Storage } from "../storage/sqlite.js";
import { applyAuthorityBoost } from "./authority-boost.js";
import { applyBacklinkBoost } from "./backlink-boost.js";
import { applyCosineRescore } from "./cosine-rescore.js";
import type { EntityIndex } from "./entity.js";
import type { IntentClassification } from "./intent.js";
import { applyTypeMultiplier } from "./intent.js";
import { applyTimeDecay, parseAnchorDate } from "./temporal.js";
import type { RetrievalHit } from "./types.js";
import { applyUsageBoost } from "./usage-boost.js";

export interface BoostOptions {
  hits: RetrievalHit[];
  input: RetrievalInput;
  intent: IntentClassification;
  primaryStorage: Storage;
  entityIndex: EntityIndex;
  recallModuleEnabled(id: string): boolean;
}

export interface BoostResult {
  hits: RetrievalHit[];
  decayActive: boolean;
}

/** Apply built-in retrieval score boosts/penalties in legacy-compatible order. */
export function applyBuiltInBoosts(opts: BoostOptions): BoostResult {
  const { hits, input, intent, primaryStorage, entityIndex, recallModuleEnabled } = opts;

  if (recallModuleEnabled("brain/cosine-rescore") && intent.weights.vector > 0) {
    for (const hit of hits) {
      const before = hit.score;
      applyCosineRescore([hit]);
      if (hit.scoring) hit.scoring.cosineBlend = hit.score / Math.max(before, Number.EPSILON);
    }
  }

  if (recallModuleEnabled("brain/type-boost") && intent.pathMultipliers !== undefined) {
    for (const hit of hits) {
      const before = hit.score;
      hit.score = applyTypeMultiplier(hit.score, hit.chunk.type, intent.pathMultipliers);
      if (hit.scoring) hit.scoring.typeMultiplier = before === 0 ? 1 : hit.score / before;
    }
  }

  const decayActive =
    recallModuleEnabled("brain/temporal-decay") &&
    intent.recencyBias === true &&
    input.anchorDate !== undefined &&
    parseAnchorDate(input.anchorDate) !== undefined;
  if (decayActive) applyTemporalDecay(hits, input.anchorDate as string);

  if (recallModuleEnabled("brain/status-penalty")) applyStatusPenalty(hits);

  if (
    recallModuleEnabled("brain/assistant-reference-boost") &&
    intent.assistantReferenceBias === true
  ) {
    for (const hit of hits) {
      if (!hit.chunk.content.startsWith("assistant:")) continue;
      hit.score *= 1.5;
      if (hit.scoring) hit.scoring.assistantBoost = 1.5;
    }
  }

  if (recallModuleEnabled("brain/backlink-boost") && hits.length > 0) {
    applyGraphBoosts(hits, primaryStorage, entityIndex);
  }

  if (recallModuleEnabled("brain/authority-boost") && hits.length > 0) applyAuthority(hits);
  if (recallModuleEnabled("brain/usage-boost") && hits.length > 0) applyUsage(hits, primaryStorage);

  return { hits, decayActive };
}

function applyTemporalDecay(hits: RetrievalHit[], anchorDate: string): void {
  const anchor = parseAnchorDate(anchorDate) as Date;
  for (const hit of hits) {
    const recordedAt = hit.chunk.metadata?.recordedAt;
    if (typeof recordedAt !== "string") continue;
    const before = hit.score;
    hit.score = applyTimeDecay(hit.score, recordedAt, anchor);
    if (hit.scoring) hit.scoring.decayMultiplier = before === 0 ? 1 : hit.score / before;
  }
}

function applyStatusPenalty(hits: RetrievalHit[]): void {
  for (const hit of hits) {
    if (hit.chunk.metadata?.status !== "superseded") continue;
    const before = hit.score;
    hit.score *= 0.35;
    if (hit.scoring) hit.scoring.statusMultiplier = hit.score / Math.max(before, Number.EPSILON);
  }
}

function applyGraphBoosts(hits: RetrievalHit[], storage: Storage, entityIndex: EntityIndex): void {
  const inbound = storage.inboundCounts(hits.map((hit) => hit.chunk.id));
  for (const hit of hits) {
    const count =
      (inbound.get(hit.chunk.id) ?? 0) +
      Math.max(entityIndex.popularityFor(hit.chunk.id), storage.entityPopularityFor(hit.chunk.id));
    if (count <= 0) continue;
    const before = hit.score;
    applyBacklinkBoost([hit], () => count);
    if (hit.scoring) hit.scoring.backlinkBoost = before === 0 ? 1 : hit.score / before;
  }
}

function applyAuthority(hits: RetrievalHit[]): void {
  const adapters = hits.map((hit) => ({
    score: hit.score,
    ...(hit.chunk.metadata !== undefined ? { metadata: hit.chunk.metadata } : {}),
  }));
  const multipliers = applyAuthorityBoost(adapters);
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const adapter = adapters[i];
    if (hit === undefined || adapter === undefined) continue;
    hit.score = adapter.score;
    if (hit.scoring && multipliers[i] !== undefined && multipliers[i] !== 1)
      hit.scoring.authorityMultiplier = multipliers[i] as number;
  }
}

function applyUsage(hits: RetrievalHit[], storage: Storage): void {
  for (const hit of hits) {
    const before = hit.score;
    const multiplier = applyUsageBoost(
      {
        score: hit.score,
        ...(hit.chunk.metadata !== undefined ? { metadata: hit.chunk.metadata } : {}),
      },
      storage.getUsage(hit.chunk.id),
    );
    hit.score = before * multiplier;
    if (hit.scoring && multiplier !== 1) hit.scoring.usageMultiplier = multiplier;
  }
}
