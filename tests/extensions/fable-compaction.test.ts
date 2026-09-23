import { expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { streamAnthropic } from "@earendil-works/pi-ai/anthropic";
import { Type } from "typebox";
import { MODELS, ensureRequiredAdaptiveThinking, stripCompactedThinking } from "../../extensions/anthropic-claude-code";

const nativeModule = process.env.PI_TEST_ANTHROPIC_API_MODULE;
const fable = MODELS.find((model) => model.id === "claude-fable-5-1")!;
const opus = MODELS.find((model) => model.id === "claude-opus-5-5")!;
const redacted = { type: "thinking" as const, thinking: "[Reasoning redacted]", thinkingSignature: "redacted-old-signature", redacted: true };
const retained: AssistantMessage = {
  role: "assistant", api: "anthropic-messages", provider: "anthropic-claude-code", model: fable.id,
  timestamp: 10, stopReason: "toolUse",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  content: [
    { type: "thinking", thinking: "Synthetic private reasoning", thinkingSignature: "original-prefix-signature" },
    redacted,
    { type: "text", text: "Read the fixture" },
    { type: "toolCall", id: "call_fixture", name: "read", arguments: { path: "fixture.txt" } },
  ],
};
const toolResult: Message = { role: "toolResult", toolCallId: "call_fixture", toolName: "read", content: [{ type: "text", text: "Fixture contents" }], isError: false, timestamp: 11 };
const oldStyleEntries = [
  { type: "message", id: "assistant", message: retained },
  { type: "message", id: "tool", message: toolResult },
  { type: "compaction", id: "compact", firstKeptEntryId: "assistant", timestamp: "2026-09-07T12:00:00Z" },
];
const selfContainedEntries = [{ type: "compaction", id: "compact", retainedTail: [retained, toolResult] }];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}

test("Fable 5.1 stays adaptive without enabling unsupported per-message effort", () => {
  expect(fable.compat).toEqual({ forceAdaptiveThinking: true });
  expect(fable.thinkingLevelMap?.off).toBeNull();
  expect(fable.thinkingLevelMap?.xhigh).toBe("xhigh");
  expect(fable.cost).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
  expect(fable.contextWindow).toBe(272_000);
  expect(fable.contextWindow).toBe(MODELS.find((model) => model.id === "claude-fable-5")!.contextWindow);
  expect(MODELS.find((model) => model.id === "claude-fable-5")?.thinkingLevelMap?.off).toBeUndefined();
});

test("Opus 5.5 declares native effort levels and the existing cost-control window", () => {
  expect(opus.name).toBe("Claude Opus 5.5 (Claude Code creds)");
  expect(opus.reasoning).toBe(true);
  expect(opus.compat).toEqual({ forceAdaptiveThinking: true, supportsTemperature: false });
  expect(opus.thinkingLevelMap).toEqual({ off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
  expect(opus.cost).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  expect(opus.input).toEqual(["text", "image"]);
  expect(opus.maxTokens).toBe(128_000);
  expect(opus.contextWindow).toBe(272_000);
  for (const id of [fable.id, "claude-opus-5"]) {
    expect(opus.contextWindow).toBe(MODELS.find((model) => model.id === id)!.contextWindow);
  }
  expect(new Set(MODELS.map((model) => model.id)).size).toBe(MODELS.length);
});

test("uncompacted append-only history is passed through unchanged", () => {
  const messages: Message[] = [retained, toolResult];
  expect(stripCompactedThinking(messages, [])).toBe(messages);
  expect(stripCompactedThinking(messages, oldStyleEntries.slice(0, 2))).toBe(messages);
});

for (const [name, entries] of [["firstKeptEntryId", oldStyleEntries], ["retainedTail/reloaded checkpoint", selfContainedEntries]] as const) {
  test(`keep-tail compaction using ${name} strips old normal/redacted thinking only`, () => {
    const fresh: AssistantMessage = { ...retained, timestamp: retained.timestamp, content: [{ type: "thinking", thinking: "New reasoning", thinkingSignature: "new-prefix-signature" }, { type: "text", text: "Continue" }], stopReason: "stop" };
    const messages: Message[] = [{ role: "user", content: "Summary", timestamp: 12 }, retained, toolResult, fresh];
    const before = JSON.stringify(messages);
    const result = stripCompactedThinking(messages, entries);
    expect(result[1]).toEqual({ ...retained, content: retained.content.slice(2) });
    expect(result[0]).toBe(messages[0]);
    expect(result[2]).toBe(toolResult);
    expect(result[3]).toBe(fresh); // same timestamp does not cause fresh thinking loss
    expect(JSON.stringify(messages)).toBe(before);
    expect(stripCompactedThinking(messages, entries)).toEqual(result); // later continuation/reload
    expect(stripCompactedThinking(result, entries)).toBe(result); // already filtered
  });
}

test("actual SessionManager compaction context uses the same retained-thinking filter", () => {
  const session = SessionManager.inMemory("/synthetic");
  session.appendMessage({ role: "user", content: "Earlier context", timestamp: 0 });
  const firstKept = session.appendMessage(retained);
  session.appendMessage(toolResult);
  session.appendCompaction("Synthetic summary", firstKept, 30_000);
  const context = session.buildSessionContext().messages;
  expect(context.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "thinking"))).toBe(true);
  const filtered = stripCompactedThinking(context, session.getBranch());
  expect(filtered.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "thinking"))).toBe(false);
  expect(filtered.some((message) => message.role === "toolResult" && message.toolCallId === "call_fixture")).toBe(true);
  // The on-disk/in-memory source remains untouched, so later requests can apply the same boundary.
  expect(session.buildSessionContext().messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "thinking"))).toBe(true);
});

test("latest compaction supersedes the earlier boundary", () => {
  const fresh: AssistantMessage = { ...retained, timestamp: 20, content: [{ type: "thinking", thinking: "New", thinkingSignature: "new-prefix-signature" }, { type: "text", text: "New answer" }] };
  const entries = [...oldStyleEntries, { type: "message", id: "new", message: fresh }, { type: "compaction", id: "second", retainedTail: [fresh] }];
  expect(stripCompactedThinking([fresh], entries)).toEqual([{ ...fresh, content: fresh.content.slice(1) }]);
});

test("summary payload normalisation is scoped and non-mutating", () => {
  for (const model of [fable.id, opus.id]) {
    for (const thinking of [undefined, { type: "disabled" }]) {
      const payload = { model, thinking, output_config: { effort: "low" }, max_tokens: 2048, messages: [{ role: "user", content: "Summary request" }] };
      const before = JSON.stringify(payload);
      expect(ensureRequiredAdaptiveThinking(payload)).toEqual({ ...payload, thinking: { type: "adaptive" } });
      expect(JSON.stringify(payload)).toBe(before);
    }
    const adaptive = { model, thinking: { type: "adaptive", display: "summarized" } };
    expect(ensureRequiredAdaptiveThinking(adaptive)).toBe(adaptive);
  }
  for (const model of ["claude-fable-5", "claude-opus-5", "other-model"]) {
    const payload = { model, thinking: { type: "disabled" } };
    expect(ensureRequiredAdaptiveThinking(payload)).toBe(payload);
  }
  expect(ensureRequiredAdaptiveThinking(null)).toBeNull();
});

type Stream = (model: Model<"anthropic-messages">, context: Context, options: {
  apiKey: string; thinkingEnabled: boolean; effort?: "low" | "high"; maxRetries?: number;
  maxTokens?: number; cacheRetention?: "none"; onPayload?: (payload: unknown) => unknown;
}) => { result(): Promise<AssistantMessage> };

function response(model: string): Response {
  const events = [
    { type: "message_start", message: { id: "msg-fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "New reasoning" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "new-prefix-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Fixture response" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function wireRegression(stream: Stream, definition = fable) {
  const modelRetained = { ...retained, model: definition.id };
  const entries = [{ type: "compaction", id: "compact", retainedTail: [modelRetained, toolResult] }];
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = record(await request.json());
    requests.push({ headers: request.headers, body });
    const text = JSON.stringify(body.messages);
    if (text.includes('"output_config"')) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "messages.output_config: Extra inputs are not permitted" } }, { status: 400 });
    if (record(body.thinking).type !== "adaptive") return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Adaptive thinking is required" } }, { status: 400 });
    if (text.includes("Compacted summary") && (text.includes("original-prefix-signature") || text.includes("redacted-old-signature"))) {
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: "thinking prefix binding mismatch" } }, { status: 400 });
    }
    return response(definition.id);
  } });
  try {
    const model: Model<"anthropic-messages"> = { ...definition, api: "anthropic-messages", provider: "anthropic-claude-code", baseUrl: server.url.toString().replace(/\/$/, "") };
    const context: Context = { systemPrompt: "Stable system", tools: [{ name: "read", description: "Read fixture", parameters: Type.Object({ path: Type.String() }) }], messages: [{ role: "user", content: "Compacted summary", timestamp: 12 }, modelRetained, toolResult] };
    const options = { apiKey: "fixture-only-key", thinkingEnabled: true, effort: "low" as const, maxRetries: 0, onPayload: ensureRequiredAdaptiveThinking };
    const before = JSON.stringify(context);
    expect((await stream(model, context, options).result()).stopReason).toBe("error"); // reproduces old bug
    const filtered = { ...context, messages: stripCompactedThinking(context.messages, entries) };
    const answer = await stream(model, filtered, options).result();
    expect(answer.stopReason).toBe("stop");
    const next: Context = { ...context, messages: [...context.messages, answer, { role: "user", content: "Continue", timestamp: Date.now() }] };
    expect((await stream(model, { ...next, messages: stripCompactedThinking(next.messages, entries) }, options).result()).stopReason).toBe("stop");
    expect(JSON.stringify(context)).toBe(before);
    const continuation = requests.at(-1)!;
    expect(JSON.stringify(continuation.body.messages)).not.toContain("original-prefix-signature");
    expect(JSON.stringify(continuation.body.messages)).toContain("new-prefix-signature");
    expect(JSON.stringify(continuation.body.messages)).toContain('"tool_use_id":"call_fixture"');
    expect(JSON.stringify(continuation.body.messages)).toContain("Fixture contents");
    expect(record(continuation.body.output_config).effort).toBe("low");
    expect(continuation.headers.get("anthropic-beta") ?? "").not.toContain("mid-conversation-output-config");
    // Summary calls can request no reasoning; the provider must still send adaptive.
    expect((await stream(model, { messages: [{ role: "user", content: "Summarise fixture", timestamp: 0 }] }, { ...options, apiKey: "sk-ant-oat-fixture-not-a-real-token", thinkingEnabled: false, maxTokens: 2048, cacheRetention: "none" }).result()).stopReason).toBe("stop");
    expect(record(requests.at(-1)!.body.thinking).type).toBe("adaptive");
    expect(requests.at(-1)!.body.max_tokens).toBe(2048);
    for (const beta of ["claude-code-20250219", "oauth-2025-04-20"]) expect(requests.at(-1)!.headers.get("anthropic-beta")).toContain(beta);
  } finally { server.stop(true); }
}

test.skipIf(!nativeModule)("Opus 5.5 native picker levels map to request-level adaptive effort, including max", async () => {
  if (!nativeModule || !isAbsolute(nativeModule)) throw new Error("PI_TEST_ANTHROPIC_API_MODULE must be an absolute local module path");
  const moduleUrl = pathToFileURL(nativeModule);
  const { getSupportedThinkingLevels } = await import(new URL("../models.js", moduleUrl).href);
  const { streamSimple } = await import(moduleUrl.href);
  const levels = ["low", "medium", "high", "xhigh", "max"];
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(record(await request.json()));
    return response(opus.id);
  } });
  try {
    const model = { ...opus, api: "anthropic-messages", provider: "anthropic-claude-code", baseUrl: server.url.toString().replace(/\/$/, "") };
    expect(getSupportedThinkingLevels(model)).toEqual(levels);
    for (const level of levels) {
      const answer = await streamSimple(model, { messages: [{ role: "user", content: "Synthetic fixture", timestamp: 0 }] }, {
        apiKey: "fixture-only-key", reasoning: level, maxRetries: 0, maxTokens: 2048,
        onPayload: ensureRequiredAdaptiveThinking,
      }).result();
      expect(answer.stopReason).toBe("stop");
      const payload = requests.at(-1)!;
      expect(payload.model).toBe(opus.id);
      expect(record(payload.thinking).type).toBe("adaptive");
      expect(record(payload.output_config).effort).toBe(level);
      expect(JSON.stringify(payload.messages)).not.toContain('"output_config"');
    }
  } finally { server.stop(true); }
});

for (const definition of [fable, opus]) {
  test(`${definition.id} pinned SDK wire regression: compacted tool turns and adaptive summaries`, async () => {
    await wireRegression(streamAnthropic, definition);
  });

  test.skipIf(!nativeModule)(`${definition.id} installed native SDK wire regression`, async () => {
    if (!nativeModule || !isAbsolute(nativeModule)) throw new Error("PI_TEST_ANTHROPIC_API_MODULE must be an absolute local module path");
    const api: unknown = await import(pathToFileURL(nativeModule).href);
    if (typeof record(api).stream !== "function") throw new Error("Native Anthropic stream export unavailable");
    await wireRegression(record(api).stream as Stream, definition);
  });
}
