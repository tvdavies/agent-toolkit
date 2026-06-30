/**
 * `brain auth status` — list every token under <home>/auth/, show
 * provider, type, expiry, freshness. JSON for cron-style scripting.
 */

import { existsSync, readdirSync } from "node:fs";
import { readToken } from "@ai-assistant/memory";
import type { ParsedArgs } from "../../shared/args.js";
import { bool, flag } from "../../shared/args.js";
import { authDir, resolveBrainHome } from "../../shared/brain.js";

type StatusEntry = {
  provider: string;
  type: "oauth" | "api-key";
  expiresAt: string | null;
  expiresInMs: number | null;
  freshness: "fresh" | "expiring-soon" | "expired" | "no-expiry" | "error";
  accountId: string | null;
  issuedAt: string;
  baseUrl: string | null;
  error?: string;
};

const FRESHNESS_WARNING_MS = 5 * 60 * 1000; // 5 min

function evaluate(entry: { type: string; expires?: number }): StatusEntry["freshness"] {
  if (entry.type !== "oauth" || entry.expires === undefined) return "no-expiry";
  const remaining = entry.expires - Date.now();
  if (remaining <= 0) return "expired";
  if (remaining <= FRESHNESS_WARNING_MS) return "expiring-soon";
  return "fresh";
}

export async function runAuthStatus(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const authPath = authDir(homeDir);
  const json = bool(args, "json");
  const entries: StatusEntry[] = [];

  if (existsSync(authPath)) {
    for (const name of readdirSync(authPath).sort()) {
      if (!name.endsWith(".json")) continue;
      const provider = name.slice(0, -".json".length);
      try {
        const token = readToken(authPath, provider);
        if (token === null) continue;
        entries.push({
          provider,
          type: token.type,
          expiresAt: token.expires !== undefined ? new Date(token.expires).toISOString() : null,
          expiresInMs: token.expires !== undefined ? token.expires - Date.now() : null,
          freshness: evaluate(token),
          accountId: token.accountId ?? null,
          issuedAt: new Date(token.issuedAt).toISOString(),
          baseUrl: token.baseUrl ?? null,
        });
      } catch (err) {
        entries.push({
          provider,
          type: "api-key",
          expiresAt: null,
          expiresInMs: null,
          freshness: "error",
          accountId: null,
          issuedAt: new Date(0).toISOString(),
          baseUrl: null,
          error: (err as Error).message,
        });
      }
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ authDir: authPath, entries }, null, 2)}\n`);
    return;
  }

  if (entries.length === 0) {
    process.stdout.write(`No tokens at ${authPath}.\n`);
    process.stdout.write("Run `brain auth login` to add one.\n");
    return;
  }

  process.stdout.write(`Tokens at ${authPath}\n`);
  for (const e of entries) {
    if (e.error !== undefined) {
      process.stdout.write(`  ${e.provider.padEnd(14)} ERROR — ${e.error.split("\n")[0]}\n`);
      continue;
    }
    const ttl = e.expiresInMs !== null ? formatDuration(e.expiresInMs) : "—";
    const tail = e.accountId !== null ? `  account=${e.accountId}` : "";
    process.stdout.write(
      `  ${e.provider.padEnd(14)} ${e.type.padEnd(8)} ${e.freshness.padEnd(14)} ttl=${ttl.padEnd(10)}${tail}\n`,
    );
  }
}

function formatDuration(ms: number): string {
  if (ms < 0) return `expired ${formatDuration(-ms)} ago`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
