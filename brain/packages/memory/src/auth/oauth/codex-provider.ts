/**
 * Build an AI SDK provider that authenticates against OpenAI's Codex
 * subscription backend using a stored OAuth token.
 *
 *   const model = buildCodexLanguageModel({ authPath, modelId: "gpt-5.4-mini" });
 *   await generateText({ model, prompt: "..." });
 *   await generateObject({ model, schema, prompt: "..." });
 *
 * Strategy: lean on `@ai-sdk/openai`'s `responses(modelId)` for the
 * heavy lifting (request shape, SSE parsing, json_schema handling)
 * and apply Codex-specific patches via:
 *
 *   1. **Provider options** — `store: false`, `instructions`,
 *      `textVerbosity` injected into `providerOptions.openai` so the
 *      OpenAI provider's own body builder writes them. Codex's variant
 *      requires all three (returns 400 otherwise).
 *   2. **Header `OpenAI-Beta: responses=experimental`** — Pi sets this
 *      on every Codex SSE call. Plus `Authorization: Bearer <token>`,
 *      `chatgpt-account-id: <accountId from JWT>`, `originator: brain`
 *      via the fetch wrapper.
 *   3. **Force streaming** — Codex has no non-streaming endpoint.
 *      `doGenerate` (used by `generateText`/`generateObject`) is
 *      overridden to call `doStream` and accumulate the parts into a
 *      single result. The AI SDK's caller doesn't care how we got
 *      the result; this is invisible to the call site.
 *
 * The fetch wrapper handles auth + refresh:
 *   - Reads the freshest stored token on every call (so a refresh
 *     from another process is picked up).
 *   - Refreshes proactively when within `REFRESH_LEEWAY_MS` of expiry,
 *     under the per-provider file lock so concurrent processes don't
 *     both burn the refresh token.
 *   - Retries once on 401 (covers exact-second expiry races).
 */

import { createOpenAI } from "@ai-sdk/openai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
  SharedV3Warning,
} from "@ai-sdk/provider";
import type { ReasoningEffort } from "../../config/index.js";
import { readToken, type StoredToken, withTokenLock, writeToken } from "../storage.js";
import { refreshCodexToken } from "./codex.js";

export const CODEX_BACKEND_BASE = "https://chatgpt.com/backend-api/codex";

/** Refresh tokens that expire within this window proactively. 2 min. */
const REFRESH_LEEWAY_MS = 120_000;

/** Originator header — Pi uses `pi`, we use `brain`. */
const ORIGINATOR = "brain";

/**
 * Default `instructions` value for Codex Responses API. The standard
 * Responses API treats `instructions` as optional; Codex's variant
 * returns 400 "Instructions are required" without one. We synthesise
 * this default when the caller didn't provide a system message.
 */
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

export type BuildCodexProviderOptions = {
  /** Path to <home>/auth/. */
  authPath: string;
  /** Provider key in storage (default `codex`). */
  providerKey?: string;
  /** Override fetch (mostly for tests). */
  fetch?: typeof fetch;
  /** Override `now()` so refresh-leeway tests are deterministic. */
  now?: () => number;
  /** Override base URL (e.g. for stubbing in tests). */
  baseURL?: string;
  /** When true, log each request URL + response status to stderr. */
  debug?: boolean;
};

/**
 * Build the underlying `@ai-sdk/openai` provider configured for the
 * Codex backend (auth, headers, base URL). Callers normally use
 * `buildCodexLanguageModel` instead, which wraps `.responses(modelId)`
 * with the Codex-specific quirks. This function is exported for
 * tests and advanced callers.
 */
export function buildCodexProvider(opts: BuildCodexProviderOptions) {
  const authPath = opts.authPath;
  const providerKey = opts.providerKey ?? "codex";
  const baseURL = opts.baseURL ?? CODEX_BACKEND_BASE;
  const baseFetch: typeof fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? (() => Date.now());

  const ensureFreshToken = async (): Promise<StoredToken> => {
    const stored = readToken(authPath, providerKey);
    if (stored === null) {
      throw new Error(
        `No codex token at ${authPath}/${providerKey}.json. Run \`brain auth login --provider codex\`.`,
      );
    }
    if (stored.type !== "oauth") {
      throw new Error(
        `Token at ${authPath}/${providerKey}.json is type "${stored.type}", not oauth.`,
      );
    }
    const expiresAt = stored.expires ?? 0;
    if (expiresAt - now() > REFRESH_LEEWAY_MS) return stored;
    return withTokenLock(authPath, providerKey, async () => {
      const latest = readToken(authPath, providerKey);
      if (
        latest !== null &&
        latest.type === "oauth" &&
        (latest.expires ?? 0) - now() > REFRESH_LEEWAY_MS
      ) {
        return latest;
      }
      const refreshed = await refreshCodexToken(latest ?? stored, {
        adapter: { fetch: baseFetch, now },
      });
      writeToken(authPath, refreshed);
      return refreshed;
    });
  };

  const log = (msg: string): void => {
    if (opts.debug) process.stderr.write(`[codex-provider] ${msg}\n`);
  };

  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const send = async (token: StoredToken): Promise<Response> => {
      const headers = new Headers(init?.headers ?? undefined);
      headers.set("Authorization", `Bearer ${token.access}`);
      if (token.accountId !== undefined) {
        headers.set("chatgpt-account-id", token.accountId);
      }
      headers.set("originator", ORIGINATOR);
      log(`→ ${method} ${url}`);
      const res = await baseFetch(input, { ...(init ?? {}), headers });
      log(`← ${res.status} ${res.statusText}`);
      if (opts.debug && res.status >= 400) {
        const cloned = res.clone();
        const body = await cloned.text();
        process.stderr.write(`[codex-provider] body:\n${body}\n`);
      }
      return res;
    };

    let token = await ensureFreshToken();
    let response = await send(token);
    if (response.status === 401) {
      token = await withTokenLock(authPath, providerKey, async () => {
        const stored = readToken(authPath, providerKey);
        if (stored === null) throw new Error("token disappeared during refresh");
        const refreshed = await refreshCodexToken(stored, {
          adapter: { fetch: baseFetch, now },
        });
        writeToken(authPath, refreshed);
        return refreshed;
      });
      response = await send(token);
    }
    return response;
  };

  return createOpenAI({
    baseURL,
    apiKey: "set-by-fetch-wrapper",
    headers: {
      // Pi's Codex SSE handler sets this; without it the backend may
      // reject reasoning-related fields.
      "OpenAI-Beta": "responses=experimental",
    },
    fetch: wrapped as unknown as typeof fetch,
  });
}

/**
 * Build a `LanguageModelV3` configured for Codex.
 *
 * Wraps `@ai-sdk/openai`'s responses model with two patches:
 *   - Injects Codex-required `providerOptions.openai` (store: false,
 *     instructions extracted from system messages, textVerbosity).
 *   - Forces `doGenerate` to use streaming + accumulate, since
 *     Codex's backend has no non-streaming endpoint.
 */
export function buildCodexLanguageModel(
  opts: BuildCodexProviderOptions & {
    modelId: string;
    /** Reasoning effort, set as `providerOptions.openai.reasoningEffort`. */
    reasoning?: ReasoningEffort;
  },
): LanguageModelV3 {
  const provider = buildCodexProvider(opts);
  const inner = provider.responses(opts.modelId);
  return wrapWithCodexQuirks(inner, {
    ...(opts.reasoning !== undefined ? { reasoning: opts.reasoning } : {}),
  });
}

type CodexQuirkOptions = {
  reasoning?: ReasoningEffort;
};

function wrapWithCodexQuirks(
  inner: LanguageModelV3,
  quirkOpts: CodexQuirkOptions = {},
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "codex",
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,

    async doGenerate(options) {
      // Codex has no non-streaming endpoint. Call doStream and
      // accumulate the parts into a LanguageModelV3GenerateResult.
      const { stream, request, response } = await inner.doStream(
        injectCodexOptions(options, quirkOpts),
      );
      return accumulateStream(stream, { request, response });
    },

    async doStream(options) {
      return inner.doStream(injectCodexOptions(options, quirkOpts));
    },
  };
}

/**
 * Apply Codex-required quirks to the call options:
 *   - Pull system messages out of the prompt and concatenate them
 *     into `providerOptions.openai.instructions` (Codex requires
 *     `instructions` in the body, separate from the input messages).
 *   - Force `store: false` (Codex refuses server-side storage on
 *     subscription accounts).
 *   - Set `textVerbosity: "low"` so the body always includes a
 *     `text` block (Pi flags this as required for Codex).
 */
function injectCodexOptions(
  options: LanguageModelV3CallOptions,
  quirkOpts: CodexQuirkOptions = {},
): LanguageModelV3CallOptions {
  const systemTexts: string[] = [];
  const promptWithoutSystem: LanguageModelV3Prompt = [];
  for (const message of options.prompt) {
    if (message.role === "system") {
      systemTexts.push(message.content);
    } else {
      promptWithoutSystem.push(message);
    }
  }
  const instructions = systemTexts.length > 0 ? systemTexts.join("\n\n") : DEFAULT_INSTRUCTIONS;

  const existingOpenAIOptions = options.providerOptions?.openai ?? {};
  return {
    ...options,
    prompt: promptWithoutSystem,
    providerOptions: {
      ...options.providerOptions,
      openai: {
        ...existingOpenAIOptions,
        store: false,
        instructions,
        textVerbosity: existingOpenAIOptions.textVerbosity ?? "low",
        // Pass reasoning through when the config asks for it. AI SDK's
        // OpenAI provider clamps to {minimal, low, medium, high} for
        // most models; gpt-5.1 supports `xhigh` and `none`. We treat
        // our config's `off` as "don't set the field at all" — the
        // model picks its own default. Distinct from `none`, which is
        // an explicit "skip reasoning" instruction OpenAI accepts on
        // gpt-5.1 only.
        ...(quirkOpts.reasoning !== undefined && quirkOpts.reasoning !== "off"
          ? { reasoningEffort: quirkOpts.reasoning }
          : {}),
      },
    },
  };
}

/**
 * Read a `LanguageModelV3StreamPart` stream and synthesise the
 * non-streaming `LanguageModelV3GenerateResult` shape `generateText`
 * / `generateObject` expect.
 *
 * We collect text and reasoning by id (the SDK uses *-start / -delta
 * / -end triples), preserve tool-calls in order, and pick up the
 * single `finish` part for usage + finish-reason. Anything else
 * passes through into `providerMetadata` if needed (today we just
 * drop the rest — extractor / observer don't use them).
 */
async function accumulateStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
  meta: { request?: { body?: unknown }; response?: LanguageModelV3StreamResult["response"] },
): Promise<LanguageModelV3GenerateResult> {
  const reader = stream.getReader();
  const textBuilders = new Map<string, string>();
  const reasoningBuilders = new Map<string, string>();
  const orderedContent: LanguageModelV3Content[] = [];
  const seenIds = new Set<string>();
  let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: undefined };
  let usage: LanguageModelV3Usage = {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
  const warnings: SharedV3Warning[] = [];
  let providerMetadata: SharedV3ProviderMetadata | undefined;

  const trackOrdered = (id: string, builder: (content: string) => LanguageModelV3Content) => {
    if (seenIds.has(id)) return;
    seenIds.add(id);
    // Placeholder — final text/reasoning string written on -end.
    orderedContent.push(builder(""));
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    switch (value.type) {
      case "stream-start":
        warnings.push(...value.warnings);
        break;
      case "text-start":
        textBuilders.set(value.id, "");
        trackOrdered(value.id, () => ({ type: "text", text: "" }));
        break;
      case "text-delta": {
        const current = textBuilders.get(value.id) ?? "";
        textBuilders.set(value.id, current + value.delta);
        break;
      }
      case "text-end": {
        const text = textBuilders.get(value.id) ?? "";
        // Replace the placeholder we appended at start.
        for (let i = orderedContent.length - 1; i >= 0; i--) {
          const candidate = orderedContent[i];
          if (candidate?.type === "text" && candidate.text === "") {
            orderedContent[i] = { type: "text", text };
            break;
          }
        }
        break;
      }
      case "reasoning-start":
        reasoningBuilders.set(value.id, "");
        trackOrdered(value.id, () => ({ type: "reasoning", text: "" }));
        break;
      case "reasoning-delta": {
        const current = reasoningBuilders.get(value.id) ?? "";
        reasoningBuilders.set(value.id, current + value.delta);
        break;
      }
      case "reasoning-end": {
        const text = reasoningBuilders.get(value.id) ?? "";
        for (let i = orderedContent.length - 1; i >= 0; i--) {
          const candidate = orderedContent[i];
          if (candidate?.type === "reasoning" && candidate.text === "") {
            orderedContent[i] = { type: "reasoning", text };
            break;
          }
        }
        break;
      }
      case "tool-call":
        orderedContent.push(value);
        break;
      case "tool-result":
        orderedContent.push(value);
        break;
      case "source":
        orderedContent.push(value);
        break;
      case "file":
        orderedContent.push(value);
        break;
      case "finish":
        finishReason = value.finishReason;
        usage = value.usage;
        if (value.providerMetadata !== undefined) {
          providerMetadata = value.providerMetadata;
        }
        break;
      case "error":
        // Surface as a thrown exception so generateText/generateObject
        // see it as a failed call rather than silently empty content.
        throw value.error instanceof Error
          ? value.error
          : new Error(typeof value.error === "string" ? value.error : "stream error");
      default:
        // tool-input-* / response-metadata / raw / etc. — leave on
        // the floor for non-streaming consumers.
        break;
    }
  }

  return {
    content: orderedContent,
    finishReason,
    usage,
    warnings,
    ...(providerMetadata !== undefined ? { providerMetadata } : {}),
    ...(meta.request !== undefined ? { request: meta.request } : {}),
    ...(meta.response !== undefined ? { response: meta.response } : {}),
  };
}
