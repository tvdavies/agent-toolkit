/**
 * `brain doctor` — health check.
 *
 * Read-only summary of the brain's index state: chunk counts by
 * type, edge counts, archived counts, last cycle status per
 * phase. Useful for cron-style cron-job logs and for hand-eyeballing
 * after a daemon run.
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { type BrainConfig, loadBrainConfig, MEMORY_TYPES } from "@ai-assistant/memory";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag } from "../shared/args.js";
import {
  authDir,
  configPath,
  logsDir,
  resolveBrainHome,
  resolveBrainPath,
  resolveScope,
} from "../shared/brain.js";

export async function runDoctor(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const json = bool(args, "json");
  const homeExists = existsSync(homeDir);
  const authPath = authDir(homeDir);
  const logsPath = logsDir(homeDir);
  const configFile = configPath(homeDir);
  const configExists = existsSync(configFile);
  const authTokens = existsSync(authPath)
    ? readdirSync(authPath).filter((n) => n.endsWith(".json")).length
    : 0;

  // Try to load the config — surface validation errors but don't
  // block the rest of the report. A broken config blocks writes
  // anyway; doctor's job is to tell you why.
  let config: BrainConfig | undefined;
  let configError: string | undefined;
  let configSource: "default" | "file" | undefined;
  let configOverrides: string[] = [];
  try {
    const result = loadBrainConfig({ homeDir });
    config = result.config;
    configSource = result.source;
    configOverrides = result.overrides;
  } catch (err) {
    configError = (err as Error).message;
  }

  const cacheDir = resolve(rootDir, ".cache");
  const dbPath = resolve(cacheDir, `${scope.replace(/\//g, "-")}.sqlite`);
  const dbExists = existsSync(dbPath);

  // Disk-side counts (markdown files) — works even when the DB
  // doesn't exist yet (fresh `brain init` then `brain doctor`).
  const filesByType: Record<string, number> = {};
  for (const type of MEMORY_TYPES) {
    const dir = resolve(rootDir, scope, type);
    if (!existsSync(dir)) continue;
    filesByType[type] = readdirSync(dir).filter((n) => n.endsWith(".md")).length;
  }
  const totalFiles = Object.values(filesByType).reduce((s, n) => s + n, 0);

  let indexCounts: Record<string, number> = {};
  let edgeCount = 0;
  let archivedCount = 0;
  let phases: Array<{
    phase: string;
    lastRunAt?: string;
    lastStatus?: string;
    lastError?: string;
  }> = [];
  if (dbExists) {
    const db = new Database(dbPath, { readonly: true });
    try {
      indexCounts = Object.fromEntries(
        db
          .prepare<{ type: string; n: number }, []>(
            `SELECT type, COUNT(*) AS n FROM chunks WHERE deleted_at IS NULL GROUP BY type`,
          )
          .all()
          .map((r) => [r.type, r.n]),
      );
      const edgeRow = db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM edges").get();
      edgeCount = edgeRow?.n ?? 0;
      const archivedRow = db
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunks WHERE deleted_at IS NOT NULL")
        .get();
      archivedCount = archivedRow?.n ?? 0;
      phases = db
        .prepare<
          {
            phase: string;
            last_run_at: number | null;
            last_status: string | null;
            last_error: string | null;
          },
          []
        >(`SELECT phase, last_run_at, last_status, last_error FROM daemon_state`)
        .all()
        .map((r) => ({
          phase: r.phase,
          ...(r.last_run_at !== null ? { lastRunAt: new Date(r.last_run_at).toISOString() } : {}),
          ...(r.last_status !== null ? { lastStatus: r.last_status } : {}),
          ...(r.last_error !== null ? { lastError: r.last_error } : {}),
        }));
    } finally {
      db.close();
    }
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          homeDir,
          homeExists,
          configFile,
          configExists,
          configSource: configSource ?? null,
          configError: configError ?? null,
          configOverrides,
          purposes: config?.purposes ?? null,
          authDir: authPath,
          authTokens,
          logsDir: logsPath,
          rootDir,
          scope,
          dbPath,
          dbExists,
          totalFiles,
          filesByType,
          indexCounts,
          edgeCount,
          archivedCount,
          phases,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`brain at ${rootDir}/${scope}\n`);
  process.stdout.write(
    `  home:     ${homeDir}${homeExists ? "" : " (missing — run `brain init`)"}\n`,
  );
  if (configError !== undefined) {
    process.stdout.write(`  config:   ERROR — ${configError.split("\n")[0]}\n`);
  } else if (configSource === "file") {
    const tail = configOverrides.length > 0 ? ` (overrides: ${configOverrides.join(", ")})` : "";
    process.stdout.write(`  config:   ${configFile}${tail}\n`);
  } else {
    process.stdout.write(`  config:   (default — no config.yaml at ${configFile})\n`);
  }
  if (config !== undefined) {
    for (const [purpose, modelKey] of Object.entries(config.purposes)) {
      const model = config.models[modelKey];
      const tail = model !== undefined ? ` → ${model.provider}/${model.id}` : "";
      process.stdout.write(`    ${purpose.padEnd(14)} ${modelKey}${tail}\n`);
    }
  }
  process.stdout.write(
    `  auth:     ${authTokens} token${authTokens === 1 ? "" : "s"} in ${authPath}\n`,
  );
  process.stdout.write(
    `  index:    ${dbExists ? dbPath : "(not built — run anything that writes)"}\n`,
  );
  process.stdout.write(`  files:    ${totalFiles} on disk\n`);
  for (const [type, n] of Object.entries(filesByType)) {
    const indexed = indexCounts[type] ?? 0;
    process.stdout.write(
      `    ${type.padEnd(14)} ${n.toString().padStart(5)} on disk · ${indexed} indexed\n`,
    );
  }
  process.stdout.write(`  edges:    ${edgeCount}\n`);
  process.stdout.write(`  archived: ${archivedCount}\n`);
  if (phases.length === 0) {
    process.stdout.write(`  daemon:   never run\n`);
  } else {
    process.stdout.write(`  daemon phases:\n`);
    for (const p of phases) {
      const tail = p.lastError !== undefined ? ` — ${p.lastError}` : "";
      process.stdout.write(
        `    ${p.phase.padEnd(14)} ${p.lastStatus ?? "?".padEnd(8)} at ${p.lastRunAt ?? "?"}${tail}\n`,
      );
    }
  }
}
