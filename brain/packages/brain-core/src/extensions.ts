import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrainModule } from "./module.js";

export type ExtensionScope = "global" | "project";

export interface ExtensionLocation {
  path: string;
  scope: ExtensionScope;
  origin: "top-level" | "directory";
  trusted: boolean;
}

export interface ExtensionDiscoveryOptions {
  homeDir: string;
  rootDir: string;
}

export interface LoadedExtension {
  location: ExtensionLocation;
  module: BrainModule;
}

export type ExtensionValidationResult = {
  path: string;
  scope: ExtensionScope;
  origin: ExtensionLocation["origin"];
  trusted: boolean;
  ok: boolean;
  name?: string;
  version?: string;
  capabilities?: string[];
  error?: string;
};

/** Return the extension directories watched/loaded by the brain runtime. */
export function extensionRoots(opts: ExtensionDiscoveryOptions): string[] {
  return [resolve(opts.homeDir, "extensions"), resolve(opts.rootDir, ".brain", "extensions")];
}

/** Discover single-file and directory-style TypeScript brain extensions. */
export async function discoverExtensions(
  opts: ExtensionDiscoveryOptions,
): Promise<ExtensionLocation[]> {
  const globalRoot = resolve(opts.homeDir, "extensions");
  const projectRoot = resolve(opts.rootDir, ".brain", "extensions");
  return [
    ...(await discoverInRoot(globalRoot, "global", opts)),
    ...(await discoverInRoot(projectRoot, "project", opts)),
  ].sort((a, b) => a.path.localeCompare(b.path));
}

/** Load discovered extensions with cache busting so reload sees edited TypeScript. */
export async function loadExtensions(opts: ExtensionDiscoveryOptions): Promise<LoadedExtension[]> {
  const locations = await discoverExtensions(opts);
  const loaded: LoadedExtension[] = [];
  for (const location of locations) {
    if (!location.trusted) {
      throw new Error(
        `refusing to load untrusted project extension: ${location.path}. Run \`brain extensions trust ${location.path}\` first.`,
      );
    }
    loaded.push({ location, module: await loadExtension(location.path) });
  }
  return loaded;
}

/** Load one extension module and validate its default export as a BrainModule. */
export async function loadExtension(path: string): Promise<BrainModule> {
  const url = pathToFileURL(path);
  url.searchParams.set("reload", String(Date.now()));
  const imported = await import(url.href);
  const value = imported.default;
  if (!isBrainModule(value)) {
    throw new Error(`extension ${path} must default-export a BrainModule`);
  }
  return value;
}

/**
 * Validate extension module shape without running setup.
 *
 * This imports module top-level code to inspect the default export. It is a
 * validation helper, not a sandbox; callers must still apply trust policy.
 */
export async function validateExtensions(
  opts: ExtensionDiscoveryOptions,
): Promise<ExtensionValidationResult[]> {
  const locations = await discoverExtensions(opts);
  const results: ExtensionValidationResult[] = [];
  for (const location of locations) results.push(await validateExtension(location));
  return results;
}

async function validateExtension(location: ExtensionLocation): Promise<ExtensionValidationResult> {
  try {
    const module = await loadExtension(location.path);
    return {
      path: location.path,
      scope: location.scope,
      origin: location.origin,
      trusted: location.trusted,
      ok: true,
      name: module.name,
      version: module.version,
      ...(module.capabilities !== undefined ? { capabilities: module.capabilities } : {}),
    };
  } catch (err) {
    return {
      path: location.path,
      scope: location.scope,
      origin: location.origin,
      trusted: location.trusted,
      ok: false,
      error: (err as Error).message,
    };
  }
}

export async function trustExtension(opts: ExtensionDiscoveryOptions, path: string): Promise<void> {
  const hash = await extensionHash(path);
  const store = await readTrustStore(opts.homeDir);
  store[path] = { hash, trustedAt: new Date().toISOString() };
  await writeTrustStore(opts.homeDir, store);
}

export async function isExtensionTrusted(
  opts: ExtensionDiscoveryOptions,
  path: string,
  scope: ExtensionScope,
): Promise<boolean> {
  if (scope === "global") return true;
  const store = await readTrustStore(opts.homeDir);
  const record = store[path];
  return record !== undefined && record.hash === (await extensionHash(path));
}

type TrustStore = Record<string, { hash: string; trustedAt: string }>;

function trustPath(homeDir: string): string {
  return resolve(homeDir, "trusted-extensions.json");
}

async function readTrustStore(homeDir: string): Promise<TrustStore> {
  try {
    return JSON.parse(await readFile(trustPath(homeDir), "utf8")) as TrustStore;
  } catch {
    return {};
  }
}

async function writeTrustStore(homeDir: string, store: TrustStore): Promise<void> {
  const path = trustPath(homeDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function extensionHash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function discoverInRoot(
  root: string,
  scope: ExtensionScope,
  opts: ExtensionDiscoveryOptions,
): Promise<ExtensionLocation[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const found: ExtensionLocation[] = [];
  for (const entry of entries) {
    if (entry.name === "proposed") continue;
    const path = resolve(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push({
        path,
        scope,
        origin: "top-level",
        trusted: await isExtensionTrusted(opts, path, scope),
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const indexPath = resolve(path, "index.ts");
    if (await isFile(indexPath))
      found.push({
        path: indexPath,
        scope,
        origin: "directory",
        trusted: await isExtensionTrusted(opts, indexPath, scope),
      });
  }
  return found;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isBrainModule(value: unknown): value is BrainModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrainModule>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.setup === "function"
  );
}
