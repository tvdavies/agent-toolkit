import { z } from "zod";
import { ToolTag } from "./connector.js";

export const Role = z.enum([
  "extraction",
  "classification",
  "entropy",
  "rerank",
  "assistant",
  "orchestration",
  "compression",
]);
export type Role = z.infer<typeof Role>;

export const Provider = z.enum(["anthropic", "openai", "google", "ollama", "mock"]);
export type Provider = z.infer<typeof Provider>;

export const RoutingHints = z.object({
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  privacyClass: z.enum(["public", "internal", "private"]).optional(),
  toolsInvolved: z.array(ToolTag).optional(),
  expectedOutputLen: z.enum(["short", "long"]).optional(),
});
export type RoutingHints = z.infer<typeof RoutingHints>;

export const RoutingRequest = z.object({
  role: Role,
  hints: RoutingHints.optional(),
  budget: z
    .object({
      maxUsd: z.number().positive().optional(),
      maxLatencyMs: z.number().positive().optional(),
    })
    .optional(),
});
export type RoutingRequest = z.infer<typeof RoutingRequest>;

export const RoutingDecision = z.object({
  provider: Provider,
  model: z.string(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type RoutingDecision = z.infer<typeof RoutingDecision>;

export const EscalationReason = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("low-confidence"), signal: z.number() }),
  z.object({ kind: z.literal("tool-error"), tool: z.string(), error: z.string() }),
  z.object({ kind: z.literal("user-flag") }),
  z.object({ kind: z.literal("timeout") }),
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

export const RoutingOutcome = z.object({
  decision: RoutingDecision,
  latencyMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  ok: z.boolean(),
});
export type RoutingOutcome = z.infer<typeof RoutingOutcome>;

export interface ModelRouter {
  select(req: RoutingRequest): Promise<RoutingDecision>;
  escalate?(from: RoutingDecision, reason: EscalationReason): Promise<RoutingDecision>;
  record?(outcome: RoutingOutcome): Promise<void>;
}
