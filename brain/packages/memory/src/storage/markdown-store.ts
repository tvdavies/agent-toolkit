/**
 * Markdown store — the source of truth for memory files.
 *
 * Layout: `<rootDir>/<scope>/<type>/<slug>.md`
 *
 * The scope is the namespacing layer (per-user, per-project,
 * per-eval-question). The type is one of the canonical memory
 * categories (facts, preferences, events, decisions, context,
 * observations, aggregates, episodic). The slug is generated
 * deterministically from the body via `generateSlug`; the store
 * resolves collisions by appending `-2`, `-3`, ... atomically.
 *
 * Files are written with `O_EXCL` so concurrent writers race safely;
 * whoever loses the race retries with the next suffix until they
 * land. Read/list/delete are straightforward filesystem operations.
 *
 * The SQLite index (sqlite.ts) tracks file paths and indexed fields
 * for retrieval; on a search hit, the orchestrator uses
 * `MarkdownStore.read` to hydrate body content from disk. Files are
 * the source of truth — when they change, the index is rebuilt or
 * patched against them, never the other way round.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { open, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { type Frontmatter, parse, serialise } from "./frontmatter.js";
import { generateSlug } from "./slug.js";

export type MemoryType =
  | "facts"
  | "preferences"
  | "events"
  | "decisions"
  | "context"
  | "observations"
  | "aggregates"
  | "episodic"
  | "reflections"
  | "patterns"
  | "procedural";

export const MEMORY_TYPES: readonly MemoryType[] = [
  "facts",
  "preferences",
  "events",
  "decisions",
  "context",
  "observations",
  "aggregates",
  "episodic",
  "reflections",
  "patterns",
];

export type MarkdownWriteInput = {
  /** Namespacing layer — e.g. "user/joe", or a per-question id during eval. */
  readonly scope: string;
  readonly type: MemoryType;
  /** Body markdown without frontmatter. */
  readonly body: string;
  /** Frontmatter fields persisted alongside the body. */
  readonly frontmatter: Frontmatter;
  /** Optional ISO date used as a slug suffix. */
  readonly recordedAt?: string;
};

export type MarkdownWriteResult = {
  readonly filePath: string;
  readonly scope: string;
  readonly type: MemoryType;
  readonly slug: string;
};

export type MarkdownReadResult = {
  readonly filePath: string;
  readonly scope: string;
  readonly type: MemoryType;
  readonly slug: string;
  readonly frontmatter: Frontmatter;
  readonly body: string;
};

export interface MarkdownStore {
  readonly rootDir: string;
  write(input: MarkdownWriteInput): Promise<MarkdownWriteResult>;
  read(filePath: string): Promise<MarkdownReadResult>;
  list(scope: string, type?: MemoryType): Promise<string[]>;
  delete(filePath: string): Promise<void>;
}

export type CreateMarkdownStoreOptions = {
  readonly rootDir: string;
};

export function createMarkdownStore(opts: CreateMarkdownStoreOptions): MarkdownStore {
  const rootDir = opts.rootDir;
  if (!isAbsolute(rootDir)) {
    throw new Error(`MarkdownStore.rootDir must be absolute: ${rootDir}`);
  }
  mkdirSync(rootDir, { recursive: true });

  return {
    rootDir,

    async write(input) {
      const scope = sanitiseScope(input.scope);
      const type = input.type;
      const dir = join(rootDir, scope, type);
      mkdirSync(dir, { recursive: true });
      const baseSlug = generateSlug(input.body, input.recordedAt);
      const text = serialise(input.frontmatter, input.body);
      const normalisedBody = input.body.replace(/\n+$/, "");

      // Atomic create-or-fail loop. The slug function is deterministic
      // so two callers building a chunk with the same body land on the
      // same first attempt. We disambiguate via two branches at EEXIST:
      //
      //   1. Same body on disk → idempotent retry (BRAIN-180). The
      //      previous attempt crashed mid-pipeline (markdown written,
      //      SQLite upsert never reached). Reuse the path and overwrite
      //      the frontmatter so disk matches this attempt's metadata
      //      (chunk ids are minted fresh per call).
      //   2. Different body, same slug → genuine collision. Append
      //      `-2`, `-3`, … until a free slot opens up.
      for (let attempt = 1; attempt <= 1024; attempt++) {
        const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
        const filePath = join(dir, `${slug}.md`);
        try {
          const handle = await open(filePath, "wx");
          try {
            await handle.writeFile(text, "utf8");
          } finally {
            await handle.close();
          }
          return { filePath, scope, type, slug };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          const existing = await readFile(filePath, "utf8");
          const parsed = parse(existing);
          if (parsed.body === normalisedBody) {
            await atomicWrite(filePath, text);
            return { filePath, scope, type, slug };
          }
        }
      }
      throw new Error(
        `MarkdownStore.write: could not find a unique slug for "${baseSlug}" after 1024 attempts`,
      );
    },

    async read(filePath) {
      const { scope, type, slug } = pathDescriptor(rootDir, filePath);
      const text = await readFile(filePath, "utf8");
      const { frontmatter, body } = parse(text);
      return { filePath, scope, type, slug, frontmatter, body };
    },

    async list(scope, type) {
      const sanitised = sanitiseScope(scope);
      const out: string[] = [];
      const types: readonly MemoryType[] = type ? [type] : MEMORY_TYPES;
      for (const t of types) {
        const dir = join(rootDir, sanitised, t);
        if (!existsSync(dir)) continue;
        for (const name of await readdir(dir)) {
          if (name.endsWith(".md")) out.push(join(dir, name));
        }
      }
      return out;
    },

    async delete(filePath) {
      // Validate the path lives under rootDir so a buggy caller can't
      // wipe arbitrary files. `pathDescriptor` throws if not.
      pathDescriptor(rootDir, filePath);
      await rm(filePath, { force: true });
    },
  };
}

/**
 * Recover (scope, type, slug) from an absolute path produced by this
 * store. Throws if the path doesn't live under rootDir or doesn't
 * follow the `<scope>/<type>/<slug>.md` shape.
 */
export function pathDescriptor(
  rootDir: string,
  filePath: string,
): { scope: string; type: MemoryType; slug: string } {
  if (!filePath.startsWith(rootDir + sep) && filePath !== rootDir) {
    throw new Error(`path ${filePath} is outside rootDir ${rootDir}`);
  }
  const rel = filePath.slice(rootDir.length + 1);
  const parts = rel.split(sep);
  // type + filename are the last two components; everything before
  // them is the scope (which may itself contain slashes, e.g. "user/joe").
  if (parts.length < 3) {
    throw new Error(`path ${filePath} doesn't match <scope>/<type>/<slug>.md`);
  }
  const fileName = parts[parts.length - 1] as string;
  const type = parts[parts.length - 2] as MemoryType;
  const scope = parts.slice(0, -2).join("/");
  if (!MEMORY_TYPES.includes(type)) {
    throw new Error(`path ${filePath} has unknown type segment "${type}"`);
  }
  if (!fileName.endsWith(".md")) {
    throw new Error(`path ${filePath} is not a .md file`);
  }
  const slug = fileName.slice(0, -3);
  return { scope, type, slug };
}

/**
 * Replace a file's contents atomically: write to a sibling tmp file
 * then `rename(2)` over the target. POSIX rename is atomic on the
 * same filesystem, so readers see either the old or the new full
 * content — never a partial overwrite.
 */
async function atomicWrite(filePath: string, text: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmpPath, text, "utf8");
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // best-effort; the tmp file is short-lived and won't conflict.
    }
    throw err;
  }
}

/**
 * Drop traversal sequences and leading slashes; allow nested scopes
 * via forward-slash separators (`user/joe`, `project/alpha`). Empty
 * scopes are coerced to `_default`.
 */
function sanitiseScope(scope: string): string {
  if (scope === "") return "_default";
  const cleaned = scope
    .split("/")
    .map((part) => part.replace(/^\.+/, "").replace(/[^a-zA-Z0-9._-]/g, "-"))
    .filter((part) => part.length > 0 && part !== "..")
    .join("/");
  return cleaned === "" ? "_default" : cleaned;
}

// Make `dirname` available to callers without re-importing node:path.
export { dirname };
