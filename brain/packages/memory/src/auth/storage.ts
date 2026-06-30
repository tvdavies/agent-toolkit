/**
 * Auth-token storage at `<homeDir>/auth/<provider>.json`.
 *
 * One file per provider. JSON for simplicity (we don't need YAML's
 * comments here; this is machine-managed). Fields are normalised
 * across providers so the consumer (buildChatModel for codex etc.)
 * doesn't have to switch on type.
 *
 * File mode: 0o600. Directory mode (set by `brain init`): 0o700.
 *
 * Concurrency: file-level lock via `<provider>.json.lock` directory
 * created with `mkdirSync(...)` (atomic). No npm dep — POSIX mkdir
 * is the standard cross-process mutex pattern. We hold the lock only
 * for the duration of read-modify-write (e.g. refresh).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const StoredToken = z.object({
  /** Auth flavour: `oauth` for refreshable bearer tokens, `api-key` for static keys. */
  type: z.enum(["oauth", "api-key"]),
  /** Bearer token (oauth) or API key (api-key). */
  access: z.string().min(1),
  /** Refresh token (oauth only). */
  refresh: z.string().min(1).optional(),
  /** Unix-ms expiry (oauth only; `undefined` for non-expiring api-keys). */
  expires: z.number().int().positive().optional(),
  /** Account / org id when the provider needs one (e.g. codex's chatgpt-account-id). */
  accountId: z.string().min(1).optional(),
  /** Optional base URL override for openai-compatible providers. */
  baseUrl: z.string().url().optional(),
  /** Provider id this token is for (matches the file name without `.json`). */
  provider: z.string().min(1),
  /** When the token was issued / last refreshed. */
  issuedAt: z.number().int().positive(),
});
export type StoredToken = z.infer<typeof StoredToken>;

export type TokenStoragePaths = {
  /** Absolute path to `<homeDir>/auth/`. */
  authDir: string;
  /** Absolute path to `<homeDir>/auth/<provider>.json`. */
  tokenPath: string;
  /** Absolute path to the lock directory. */
  lockPath: string;
};

export function tokenPaths(authRoot: string, provider: string): TokenStoragePaths {
  const tokenPath = resolve(authRoot, `${provider}.json`);
  return {
    authDir: authRoot,
    tokenPath,
    lockPath: `${tokenPath}.lock`,
  };
}

/**
 * Read the stored API key for a given provider key, or null if no
 * file exists / the file isn't an api-key token. OAuth tokens (codex
 * etc.) return null — callers wanting bearer access should use
 * `readToken` and inspect `.type`.
 */
export function readApiKey(authRoot: string, provider: string): string | null {
  const token = readToken(authRoot, provider);
  if (token === null) return null;
  if (token.type !== "api-key") return null;
  return token.access;
}

/** Read a stored token; returns null if the file doesn't exist. */
export function readToken(authRoot: string, provider: string): StoredToken | null {
  const { tokenPath } = tokenPaths(authRoot, provider);
  if (!existsSync(tokenPath)) return null;
  const body = readFileSync(tokenPath, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new Error(`failed to parse token at ${tokenPath}: ${(err as Error).message}`);
  }
  const result = StoredToken.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid token at ${tokenPath}:\n${issues}`);
  }
  return result.data;
}

/** Write a token atomically with chmod 600. Creates the auth dir if missing. */
export function writeToken(authRoot: string, token: StoredToken): void {
  if (!existsSync(authRoot)) {
    mkdirSync(authRoot, { recursive: true, mode: 0o700 });
  }
  const { tokenPath } = tokenPaths(authRoot, token.provider);
  // Write to a tmp sibling, chmod 600 in case the umask masked it
  // off, then rename — POSIX-atomic on the same filesystem.
  const tmp = `${tokenPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, tokenPath);
}

/** Delete a token file. Returns true if a file was removed, false if none existed. */
export function deleteToken(authRoot: string, provider: string): boolean {
  const { tokenPath } = tokenPaths(authRoot, provider);
  if (!existsSync(tokenPath)) return false;
  rmSync(tokenPath, { force: true });
  return true;
}

/**
 * Acquire an exclusive lock on a provider's token file.
 *
 * Implementation: try to `mkdir <provider>.json.lock` — atomic on POSIX.
 * If it exists we retry with backoff up to `timeoutMs`. The lock is a
 * directory (not a file) so no file-handle inheritance issues with bun.
 *
 * Caller MUST call the returned `release()` in a finally block.
 */
export async function acquireTokenLock(
  authRoot: string,
  provider: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<{ release: () => void }> {
  if (!existsSync(authRoot)) {
    mkdirSync(authRoot, { recursive: true, mode: 0o700 });
  }
  const { lockPath } = tokenPaths(authRoot, provider);
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      mkdirSync(lockPath); // atomic; throws EEXIST if held
      return {
        release: () => {
          try {
            rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // Already gone — fine. Don't crash on cleanup.
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for token lock at ${lockPath}. ` +
            "Another `brain auth` invocation may be holding it; remove the directory if stale.",
        );
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}

/** Run `fn` while holding the token lock. Returns whatever `fn` returns. */
export async function withTokenLock<T>(
  authRoot: string,
  provider: string,
  fn: () => Promise<T> | T,
  opts?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<T> {
  const { release } = await acquireTokenLock(authRoot, provider, opts);
  try {
    return await fn();
  } finally {
    release();
  }
}
