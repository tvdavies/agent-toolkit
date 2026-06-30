import { z } from "zod";
import { RetrievalResult } from "./memory.js";
import { EscalationReason, RoutingDecision } from "./router.js";

export const SessionEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("turn-start"),
    ts: z.date(),
    turnId: z.string(),
    input: z.string(),
  }),
  z.object({
    type: z.literal("retrieval"),
    ts: z.date(),
    turnId: z.string(),
    result: RetrievalResult,
  }),
  z.object({
    type: z.literal("routing"),
    ts: z.date(),
    turnId: z.string(),
    decision: RoutingDecision,
  }),
  z.object({
    type: z.literal("model-call"),
    ts: z.date(),
    turnId: z.string(),
    provider: z.string(),
    model: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    latencyMs: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("tool-call"),
    ts: z.date(),
    turnId: z.string(),
    tool: z.string(),
    args: z.unknown(),
    result: z.unknown(),
    latencyMs: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("turn-end"),
    ts: z.date(),
    turnId: z.string(),
    output: z.string(),
  }),
  z.object({
    type: z.literal("escalation"),
    ts: z.date(),
    turnId: z.string(),
    reason: EscalationReason,
    from: RoutingDecision,
    to: RoutingDecision,
  }),
  z.object({
    type: z.literal("feedback"),
    ts: z.date(),
    turnId: z.string(),
    signal: z.string(),
  }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
