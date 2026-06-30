/**
 * Long-running filesystem watcher that reconciles edits to the
 * markdown store back into the SQLite index.
 *
 * Hosted by `brain daemon` (and the legacy `brain watch` until we
 * delete it). Run as a coroutine alongside the queue-drain loop —
 * one PID, one log, one source of truth for "the brain is awake."
 *
 * Behaviour:
 *  - Bun/Node's `fs.watch` fires on create / modify / delete / rename.
 *  - Per-path debounce so editor save-bursts (`.swp` dance, atomic
 *    write-then-rename) collapse into one reindex call.
 *  - Skip files outside `<scope>/<type>/*.md` and the `.cache/`
 *    subtree.
 *  - Hash-based skip in `reindexFile`: a `touch` that doesn't change
 *    bytes is a no-op.
 *  - If a notification fires while a path is mid-reindex, the path
 *    is marked for one follow-up reindex when the in-flight call
 *    finishes — never more than one queued.
 *
 * Stop semantics: caller owns the `stop()`. AbortController-based;
 * `stop()` aborts the underlying `fs.watch` async iterator and
 * returns immediately. Pending debounced reindexes are cancelled.
 * In-flight reindexes finish naturally (we don't try to interrupt
 * them — the SQLite/markdown writes shouldn't be left half-done).
 */

import { watch } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createGatewayEmbedder,
  type Embedder,
  type MarkdownStore,
  reindexFile,
  type Storage,
  type UsageMeter,
} from "@ai-assistant/memory";

export type FileWatcherOptions = {
  /** Directory to watch recursively (typically `<rootDir>/<scope>`). */
  scopeDir: string;
  storage: Storage;
  markdownStore: MarkdownStore;
  /** Per-path debounce window in ms. Default 150. */
  debounceMs?: number;
  /** When false, skip embedding during reindex (BM25 only). */
  embedOnReindex?: boolean;
  /** Required when `embedOnReindex` is true (caller chooses gateway/local). */
  embedder?: Embedder;
  /** Optional usage meter passed to a default embedder if `embedder` isn't supplied. */
  usage?: UsageMeter;
  /** Logger. Default writes to stdout. */
  log?: (line: string) => void;
};

export type FileWatcher = {
  stop: () => Promise<void>;
};

const DEFAULT_DEBOUNCE_MS = 150;

export function startFileWatcher(opts: FileWatcherOptions): FileWatcher {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const log = opts.log ?? ((line) => process.stdout.write(`${line}\n`));
  const ac = new AbortController();

  const embedder: Embedder | undefined =
    opts.embedOnReindex === false
      ? undefined
      : (opts.embedder ?? createGatewayEmbedder({ usage: opts.usage }));

  const pending = new Map<string, NodeJS.Timeout>();
  const inFlight = new Map<string, "running" | "follow-up">();

  const reindex = async (filePath: string): Promise<void> => {
    if (inFlight.has(filePath)) {
      inFlight.set(filePath, "follow-up");
      return;
    }
    inFlight.set(filePath, "running");
    try {
      const result = await reindexFile(filePath, {
        storage: opts.storage,
        markdownStore: opts.markdownStore,
        ...(embedder ? { embedder } : {}),
      });
      log(`watch: ${result.outcome.padEnd(20)} ${trimPath(filePath, opts.scopeDir)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`watch: reindex failed — ${trimPath(filePath, opts.scopeDir)} — ${msg}`);
    } finally {
      const followUp = inFlight.get(filePath) === "follow-up";
      inFlight.delete(filePath);
      if (followUp && !ac.signal.aborted) await reindex(filePath);
    }
  };

  const schedule = (filePath: string): void => {
    const existing = pending.get(filePath);
    if (existing !== undefined) clearTimeout(existing);
    pending.set(
      filePath,
      setTimeout(() => {
        pending.delete(filePath);
        void reindex(filePath);
      }, debounceMs),
    );
  };

  const loop = async (): Promise<void> => {
    try {
      for await (const event of watch(opts.scopeDir, {
        recursive: true,
        signal: ac.signal,
      })) {
        const fileName = event.filename;
        if (fileName === null || fileName === undefined) continue;
        if (!fileName.endsWith(".md")) continue;
        if (fileName.includes(".cache/")) continue;
        schedule(resolve(opts.scopeDir, fileName));
      }
    } catch (err) {
      // AbortError is the expected exit when stop() fires; anything
      // else surfaces as a log line. We don't crash the daemon for
      // a watcher hiccup — the queue-drain loop is independent.
      const code = (err as NodeJS.ErrnoException).code ?? "";
      const name = (err as Error).name ?? "";
      if (code === "ABORT_ERR" || name === "AbortError") return;
      log(`watch: loop error — ${(err as Error).message}`);
    }
  };

  // Kick off the loop in the background; caller can ignore the
  // returned promise — stop() handles teardown.
  void loop();

  return {
    async stop() {
      ac.abort();
      // Cancel any pending debounced reindexes; in-flight ones finish.
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
  };
}

function trimPath(filePath: string, base: string): string {
  return filePath.startsWith(`${base}/`) ? filePath.slice(base.length + 1) : filePath;
}
