/**
 * Codex-subscription OAuth dance + refresh.
 *
 * Uses OpenAI's public Codex client_id (`app_EMoamEEZ73f0CkXaXp7hrann`) —
 * the same id the official Codex CLI and Pi use. Public PKCE client,
 * no client secret, no developer-console step required.
 *
 *   performCodexLogin({ ... }) → StoredToken
 *   refreshCodexToken(stored)  → StoredToken (rotated when supported)
 *
 * The login function takes an optional `adapter` so tests can inject
 * a fake fetch + fake server + fake browser-opener. Production
 * callers leave it undefined and get the real implementations.
 */

import { spawn } from "node:child_process";
import type { StoredToken } from "../storage.js";
import { extractCodexAccountId } from "./jwt.js";
import { generatePkceVerifier, generateState, pkceChallenge } from "./pkce.js";
import { type CallbackServer, startCallbackServer } from "./server.js";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_SCOPES = "openid profile email offline_access";
export const DEFAULT_CALLBACK_PORT = 1455;

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

export type CodexLoginAdapter = {
  fetch: typeof fetch;
  startServer: (opts: { port: number }) => Promise<CallbackServer>;
  openBrowser: (url: string) => void | Promise<void>;
  generateVerifier: () => string;
  generateState: () => string;
  /** `() => Date.now()` in production; injectable for stable tests. */
  now: () => number;
};

export type PerformCodexLoginOptions = {
  /** Defaults to env `BRAIN_OAUTH_CALLBACK_PORT` then 1455. */
  port?: number;
  /** Wait this long for the browser callback before bailing. Default 5 min. */
  timeoutMs?: number;
  /** Override individual deps for testing. */
  adapter?: Partial<CodexLoginAdapter>;
  /** Optional sink for status messages so callers can integrate with their UI. */
  onMessage?: (msg: string) => void;
  env?: NodeJS.ProcessEnv;
};

const realAdapter: CodexLoginAdapter = {
  fetch: globalThis.fetch.bind(globalThis),
  startServer: ({ port }) => startCallbackServer({ port }),
  openBrowser: defaultOpenBrowser,
  generateVerifier: () => generatePkceVerifier(),
  generateState: () => generateState(),
  now: () => Date.now(),
};

export async function performCodexLogin(opts: PerformCodexLoginOptions = {}): Promise<StoredToken> {
  const adapter: CodexLoginAdapter = { ...realAdapter, ...(opts.adapter ?? {}) };
  const env = opts.env ?? process.env;
  const port = opts.port ?? (Number(env.BRAIN_OAUTH_CALLBACK_PORT) || DEFAULT_CALLBACK_PORT);
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const tell = opts.onMessage ?? ((msg) => process.stdout.write(`${msg}\n`));

  const verifier = adapter.generateVerifier();
  const challenge = pkceChallenge(verifier);
  const state = adapter.generateState();

  const server = await adapter.startServer({ port });
  try {
    const redirectUri = server.url;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CODEX_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: CODEX_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const authorizeUrl = `${CODEX_AUTHORIZE_URL}?${params.toString()}`;

    tell(`Opening browser for OpenAI sign-in…`);
    tell(`If it doesn't open automatically, paste this into your browser:`);
    tell(`  ${authorizeUrl}`);
    await adapter.openBrowser(authorizeUrl);

    const callback = await Promise.race([server.receive(), timeoutAfter(timeoutMs)]);
    if (callback.kind === "error") {
      const tail = callback.description !== undefined ? ` — ${callback.description}` : "";
      throw new Error(`OAuth provider returned error: ${callback.error}${tail}`);
    }
    if (callback.state !== state) {
      throw new Error(
        "OAuth state mismatch — the callback's state didn't match what we sent. Aborting (possible CSRF).",
      );
    }

    const tokenResponse = await adapter.fetch(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CODEX_CLIENT_ID,
        code: callback.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const body = await safeReadText(tokenResponse);
      throw new Error(`Token exchange failed (HTTP ${tokenResponse.status}): ${body}`);
    }

    const tokens = (await tokenResponse.json()) as TokenResponse;
    if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
      throw new Error("Token response missing access_token");
    }

    const accountId = extractCodexAccountId(tokens.access_token);
    const now = adapter.now();
    return {
      type: "oauth",
      access: tokens.access_token,
      ...(typeof tokens.refresh_token === "string" ? { refresh: tokens.refresh_token } : {}),
      expires: now + tokens.expires_in * 1000,
      accountId,
      provider: "codex",
      issuedAt: now,
    };
  } finally {
    await server.close();
  }
}

export type RefreshCodexAdapter = {
  fetch: typeof fetch;
  now: () => number;
};

const realRefreshAdapter: RefreshCodexAdapter = {
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
};

export async function refreshCodexToken(
  stored: StoredToken,
  opts: { adapter?: Partial<RefreshCodexAdapter> } = {},
): Promise<StoredToken> {
  const adapter: RefreshCodexAdapter = { ...realRefreshAdapter, ...(opts.adapter ?? {}) };
  if (stored.type !== "oauth") {
    throw new Error(`Refusing to refresh: token is type "${stored.type}", not oauth.`);
  }
  if (!stored.refresh) {
    throw new Error("No refresh token stored. Re-run `brain auth login --provider codex`.");
  }
  const tokenResponse = await adapter.fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CODEX_CLIENT_ID,
      refresh_token: stored.refresh,
    }),
  });
  if (!tokenResponse.ok) {
    const body = await safeReadText(tokenResponse);
    throw new Error(`Refresh failed (HTTP ${tokenResponse.status}): ${body}`);
  }
  const tokens = (await tokenResponse.json()) as TokenResponse;
  if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
    throw new Error("Refresh response missing access_token");
  }
  const accountId = extractCodexAccountId(tokens.access_token);
  const now = adapter.now();
  // OpenAI may or may not rotate refresh tokens; keep what we got
  // back if present, otherwise fall back to the existing one.
  const refresh = typeof tokens.refresh_token === "string" ? tokens.refresh_token : stored.refresh;
  return {
    type: "oauth",
    access: tokens.access_token,
    refresh,
    expires: now + tokens.expires_in * 1000,
    accountId,
    provider: stored.provider,
    issuedAt: now,
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "(failed to read response body)";
  }
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () =>
        reject(new Error(`Timed out after ${Math.round(ms / 1000)}s waiting for browser callback`)),
      ms,
    );
  });
}

function defaultOpenBrowser(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(opener, [url], { stdio: "ignore", detached: true });
  child.unref();
  // Don't wait for the browser process — fire and forget. If the
  // browser doesn't open, the user can paste the URL printed above.
}
