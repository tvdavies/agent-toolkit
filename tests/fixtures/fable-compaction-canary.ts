// Opt-in live canary, loaded only through an explicitly authorised native subagent.
// It exposes synthetic values, rewrites one request prefix after a completed tool
// round, and records metadata only. It never reads source files or credentials.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stripCompactedThinking } from "../../extensions/anthropic-claude-code";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export default function (pi: ExtensionAPI) {
  let alphaRead = false;
  let betaRead = false;
  let compacted = false;
  let boundary: readonly unknown[] | undefined;
  let requests = 0;
  pi.registerTool({
    name: "canary_value", label: "Canary value", description: "Read one synthetic canary value; read alpha first, then beta in a later turn.",
    parameters: Type.Object({ key: Type.String({ enum: ["alpha", "beta"] }) }),
    async execute(_id, args) {
      if (args.key === "alpha" && !alphaRead) {
        alphaRead = true;
        return { content: [{ type: "text", text: "alpha = 37. Now request beta in your next turn." }], details: {} };
      }
      if (args.key === "beta" && alphaRead && compacted && !betaRead) {
        betaRead = true;
        return { content: [{ type: "text", text: "beta = 5. Return the sum and stop." }], details: {} };
      }
      throw new Error("Canary sequence requires alpha once, then beta once in a later turn.");
    },
  });
  pi.on("context", (event) => {
    if (!event.messages.some((message) => message.role === "toolResult" && message.toolName === "canary_value")) return;
    const firstUser = event.messages.findIndex((message) => message.role === "user");
    if (firstUser < 0) return;
    const retainedThinking = event.messages.filter((message) => message.role === "assistant")
      .reduce((count, message) => count + message.content.filter((block) => block.type === "thinking" && Boolean(block.thinkingSignature)).length, 0);
    compacted = true;
    // Exercise the exact production filter with a synthetic self-contained
    // compaction boundary, without writing private SessionManager state.
    boundary ??= [{ type: "compaction", id: "synthetic-canary-boundary", retainedTail: event.messages.slice(firstUser + 1) }];
    const rewritten = event.messages.map((message, index) => index === firstUser && message.role === "user"
      ? { ...message, content: "Compacted summary: this synthetic provider canary must read alpha, then beta in separate turns, and return their sum. The completed alpha read is preserved below; continue with beta if needed, otherwise return the sum. Do not use other tools or repeat completed reads." }
      : message);
    const messages = stripCompactedThinking(rewritten, boundary);
    const remainingThinking = messages.filter((message) => message.role === "assistant")
      .reduce((count, message) => count + message.content.filter((block) => block.type === "thinking" && Boolean(block.thinkingSignature)).length, 0);
    pi.appendEntry("fable-compaction-canary", { event: "prefix-replaced", retainedThinking, removedThinking: retainedThinking - remainingThinking, remainingThinking, toolRoundComplete: true });
    return { messages };
  });
  pi.on("before_provider_request", (event, ctx) => {
    const body = record(event.payload);
    const thinking = record(body?.thinking);
    requests++;
    pi.appendEntry("fable-compaction-canary", { event: "request", request: requests, model: ctx.model?.id,
      thinkingType: thinking?.type, prefixMismatchBehavior: record(thinking?.block_binding)?.prefix_mismatch_behavior,
      bindingBeta: Array.isArray(body?.betas) && body.betas.includes("thinking-binding-controls-2026-08-01"), compacted });
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const diagnostics = record(event.message)?.diagnostics;
    const reasons: string[] = [];
    for (const diagnostic of Array.isArray(diagnostics) ? diagnostics : []) {
      const data = record(diagnostic);
      if (data?.type !== "anthropic_input_transformations") continue;
      const transformations = record(data.details)?.transformations;
      for (const transformation of Array.isArray(transformations) ? transformations : []) {
        const reason = record(transformation)?.reason;
        if (reason === "prefix_binding_mismatch" || reason === "model_binding_mismatch") reasons.push(reason);
      }
    }
    pi.appendEntry("fable-compaction-canary", { event: "response", request: requests,
      stopReason: event.message.stopReason, reasons, alphaRead, betaRead });
  });
}
