import { BUILT_IN_RECALL_MODULE_IDS as RECALL_MODULE_IDS } from "../retrieval/modules.js";
import type { ModuleRef } from "./schema.js";

export const DEFAULT_REMEMBER_WRITERS = [
  "brain/verbatim-writer",
  "brain/procedural-memory",
  "brain/deterministic-extraction",
  "brain/llm-extraction",
  "brain/observation-writer",
] as const;

export const DEFAULT_ASYNC_WRITERS = DEFAULT_REMEMBER_WRITERS.filter(
  (id) => id !== "brain/verbatim-writer",
);
export const DEFAULT_SYNC_WRITER = "brain/verbatim-writer";
export const DEFAULT_RECALL_MODULES = RECALL_MODULE_IDS;

/** Return enabled module ids from config refs, preserving order. */
export function enabledModuleIds(
  refs: readonly ModuleRef[] | undefined,
  fallback: readonly string[],
): string[] {
  const source = refs ?? fallback;
  return source.flatMap((ref) => {
    if (typeof ref === "string") return [ref];
    return ref.enabled === false ? [] : [ref.id];
  });
}

/** Resolve a single module ref. Disabled refs return undefined so callers can fall back. */
export function enabledModuleId(ref: ModuleRef | undefined, fallback: string): string {
  if (ref === undefined) return fallback;
  if (typeof ref === "string") return ref;
  return ref.enabled === false ? fallback : ref.id;
}
