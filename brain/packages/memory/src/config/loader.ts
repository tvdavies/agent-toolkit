/**
 * Load + validate `<home>/config.yaml`.
 *
 *   loadBrainConfig({ homeDir })
 *
 * Resolution:
 *   1. Path: `BRAIN_CONFIG=<path>` env var > `<homeDir>/config.yaml`.
 *   2. Missing file → `defaultConfig()` (today's hardcoded stack).
 *   3. Present file → YAML parse + zod validate. Throws on either
 *      with a path-prefixed message so the user knows which key
 *      is wrong.
 *   4. Env-var overrides applied last:
 *        BRAIN_PURPOSE_EXTRACTOR=<model>
 *        BRAIN_PURPOSE_OBSERVER=<model>
 *        BRAIN_PURPOSE_CONSOLIDATOR=<model>
 *        BRAIN_PURPOSE_CONTEXTUALISER=<model>
 *        BRAIN_PURPOSE_EMBEDDER=<model>
 *        BRAIN_PURPOSE_RERANKER=<model>
 *      Override target must reference a known model after parsing
 *      or we throw — twelve-factor's "env wins" only works if the
 *      env value is valid.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { defaultConfig } from "./defaults.js";
import { BrainConfig, PURPOSES } from "./schema.js";

export type LoadOptions = {
  homeDir: string;
  /** Override env vars for testing. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

export type LoadResult = {
  config: BrainConfig;
  source: "default" | "file";
  /** Absolute path of the loaded file, or null when defaults were used. */
  path: string | null;
  /** Names of env vars that overrode purposes. */
  overrides: string[];
};

const PURPOSE_ENV: Record<(typeof PURPOSES)[number], string> = {
  extractor: "BRAIN_PURPOSE_EXTRACTOR",
  observer: "BRAIN_PURPOSE_OBSERVER",
  consolidator: "BRAIN_PURPOSE_CONSOLIDATOR",
  contextualiser: "BRAIN_PURPOSE_CONTEXTUALISER",
  embedder: "BRAIN_PURPOSE_EMBEDDER",
  reranker: "BRAIN_PURPOSE_RERANKER",
};

export function loadBrainConfig(opts: LoadOptions): LoadResult {
  const env = opts.env ?? process.env;
  const path = env.BRAIN_CONFIG ?? resolve(opts.homeDir, "config.yaml");

  let parsed: BrainConfig;
  let source: LoadResult["source"];
  let resolvedPath: string | null;

  if (existsSync(path)) {
    const body = readFileSync(path, "utf8");
    let raw: unknown;
    try {
      raw = parse(body);
    } catch (err) {
      throw new Error(`failed to parse YAML at ${path}: ${(err as Error).message}`);
    }
    const result = BrainConfig.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw new Error(`invalid config at ${path}:\n${issues}`);
    }
    parsed = result.data;
    source = "file";
    resolvedPath = path;
  } else if (env.BRAIN_CONFIG) {
    throw new Error(`BRAIN_CONFIG points at "${path}" but no file exists there`);
  } else {
    parsed = defaultConfig();
    source = "default";
    resolvedPath = null;
  }

  const overrides: string[] = [];
  const modelKeys = new Set(Object.keys(parsed.models));
  for (const purpose of PURPOSES) {
    const envName = PURPOSE_ENV[purpose];
    const override = env[envName];
    if (override !== undefined && override !== "") {
      if (!modelKeys.has(override)) {
        throw new Error(
          `${envName}="${override}" but no such model is defined. Known models: ${[...modelKeys].sort().join(", ") || "(none)"}`,
        );
      }
      parsed.purposes[purpose] = override;
      overrides.push(envName);
    }
  }

  return { config: parsed, source, path: resolvedPath, overrides };
}
