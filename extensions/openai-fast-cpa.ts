import * as fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * OpenAI Fast mode for the CPA-routed openai-codex provider.
 *
 * Replaces @diegopetrucci/pi-openai-fast, which requires ChatGPT OAuth and the
 * openai-codex-responses api and therefore never activates now that openai-codex
 * routes through CLI Proxy API (openai-responses + API key). CPA's
 * Responses->Codex translator forwards service_tier only when it equals
 * "priority", so injecting it here reaches the ChatGPT Codex backend intact.
 */

const DEFAULT_PROVIDER_IDS = ["openai-codex"];
const FAST_SERVICE_TIER = "priority";

// Fast mode applies to GPT models from 5.4 onwards, so new releases such as
// gpt-6.1-sol qualify without editing this file. Small variants (mini, nano,
// codex-spark) stay excluded, as they were from the original allowlist.
const MIN_FAST_VERSION: [number, number] = [5, 4];
const GPT_VERSION = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/;
const EXCLUDED_VARIANT = /-(mini|nano|codex-spark)(?:-|$)/;

function csv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

/** Providers routed through CLI Proxy API. Extend with PI_OPENAI_FAST_PROVIDERS. */
export function fastProviderIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set([...DEFAULT_PROVIDER_IDS, ...csv(env.PI_OPENAI_FAST_PROVIDERS)]);
}

/** Whether a model id supports priority processing. PI_OPENAI_FAST_EXCLUDE_MODELS opts ids out. */
export function isFastModel(modelId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const id = modelId.toLowerCase();
  if (csv(env.PI_OPENAI_FAST_EXCLUDE_MODELS).some((excluded) => excluded.toLowerCase() === id)) return false;
  const match = GPT_VERSION.exec(id);
  if (!match || EXCLUDED_VARIANT.test(id)) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  const [minMajor, minMinor] = MIN_FAST_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

const DEBUG_PAYLOAD_PATH = process.env.PI_OPENAI_FAST_CPA_DEBUG_PATH;

// Session override: "auto" follows the default (enabled), "on"/"off" force it.
let override: "auto" | "on" | "off" = "auto";
const DEFAULT_ENABLED = true;

function isEnabled(): boolean {
  if (override === "on") return true;
  if (override === "off") return false;
  return DEFAULT_ENABLED;
}

function isEligible(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  return Boolean(model && fastProviderIds().has(model.provider) && isFastModel(model.id));
}

async function maybeDumpPayload(payload: unknown): Promise<void> {
  if (!DEBUG_PAYLOAD_PATH) return;
  try {
    await fs.writeFile(DEBUG_PAYLOAD_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Debug-only; never break provider requests.
  }
}

function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("openai-fast-cpa", isEnabled() && isEligible(ctx) ? "fast" : undefined);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    override = "auto";
    updateStatus(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    updateStatus(ctx);
    if (!isEnabled() || !isEligible(ctx)) return;
    const payload = event.payload as Record<string, unknown>;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    if (payload.model !== ctx.model?.id) return;
    if ("service_tier" in payload) return;
    const next = { ...payload, service_tier: FAST_SERVICE_TIER };
    await maybeDumpPayload(next);
    return next;
  });

  pi.registerCommand("fast", {
    description: "Toggle OpenAI Fast mode (service_tier=priority via CPA) for GPT-5.4 and newer models",
    handler: async (_args, ctx) => {
      override = isEnabled() ? "off" : "on";
      updateStatus(ctx);
      const state = isEnabled() ? "on" : "off";
      const scope = isEligible(ctx)
        ? `active for ${ctx.model?.provider}/${ctx.model?.id}`
        : `inactive for current model (needs ${[...fastProviderIds()].join("/")} + GPT-5.4 or newer)`;
      ctx.ui.notify(`OpenAI Fast mode: ${state}; ${scope}`, "info");
    },
  });
}
