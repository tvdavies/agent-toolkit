import { describe, expect, it } from "vitest";
import {
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
  performCodexLogin,
  refreshCodexToken,
} from "../src/auth/oauth/index.ts";
import type { CallbackServer } from "../src/auth/oauth/server.ts";
import type { StoredToken } from "../src/auth/storage.ts";

function makeJwt(claim: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": claim })).toString(
    "base64url",
  );
  return `${header}.${body}.fakesignature`;
}

function fakeServer(
  callback: () => Promise<
    { kind: "code"; code: string; state: string } | { kind: "error"; error: string }
  >,
): CallbackServer {
  return {
    url: "http://localhost:1455/auth/callback",
    port: 1455,
    receive: callback,
    close: async () => undefined,
  };
}

describe("performCodexLogin", () => {
  it("happy path: builds correct authorize URL, exchanges code, returns StoredToken", async () => {
    const accessToken = makeJwt({ chatgpt_account_id: "acc-happy" });
    let openedUrl = "";
    const fetchCalls: { url: string; body: string }[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      fetchCalls.push({ url, body });
      return new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: "rt-happy",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    let captured: string | undefined;
    const token = await performCodexLogin({
      adapter: {
        fetch: fetchMock,
        startServer: async () =>
          fakeServer(async () => ({ kind: "code", code: "auth-code-1", state: "STATE_FIXED" })),
        openBrowser: (url) => {
          openedUrl = url;
        },
        generateVerifier: () => "VERIFIER_FIXED",
        generateState: () => "STATE_FIXED",
        now: () => 1_700_000_000_000,
      },
      onMessage: (msg) => {
        captured = msg;
      },
    });

    // Authorize URL was opened with the right params.
    expect(openedUrl).toContain(CODEX_AUTHORIZE_URL);
    expect(openedUrl).toContain(`client_id=${CODEX_CLIENT_ID}`);
    expect(openedUrl).toContain("code_challenge_method=S256");
    expect(openedUrl).toContain("scope=openid+profile+email+offline_access");
    expect(openedUrl).toContain("state=STATE_FIXED");

    // Token exchange used POST with the verifier replayed.
    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    if (!call) throw new Error("expected one fetch call");
    expect(call.url).toBe(CODEX_TOKEN_URL);
    expect(call.body).toContain("grant_type=authorization_code");
    expect(call.body).toContain("code=auth-code-1");
    expect(call.body).toContain("code_verifier=VERIFIER_FIXED");

    expect(captured).toBeDefined();
    expect(token).toMatchObject({
      type: "oauth",
      access: accessToken,
      refresh: "rt-happy",
      provider: "codex",
      accountId: "acc-happy",
      issuedAt: 1_700_000_000_000,
      expires: 1_700_000_000_000 + 3600 * 1000,
    });
  });

  it("rejects state mismatch (CSRF guard)", async () => {
    await expect(
      performCodexLogin({
        adapter: {
          fetch: (async () => new Response("never", { status: 200 })) as typeof fetch,
          startServer: async () =>
            fakeServer(async () => ({ kind: "code", code: "x", state: "WRONG" })),
          openBrowser: () => undefined,
          generateVerifier: () => "v",
          generateState: () => "RIGHT",
          now: () => 0,
        },
        onMessage: () => undefined,
      }),
    ).rejects.toThrow(/state mismatch/);
  });

  it("propagates OAuth provider errors via callback", async () => {
    await expect(
      performCodexLogin({
        adapter: {
          fetch: (async () => new Response("never", { status: 200 })) as typeof fetch,
          startServer: async () =>
            fakeServer(async () => ({ kind: "error", error: "access_denied" })),
          openBrowser: () => undefined,
          generateVerifier: () => "v",
          generateState: () => "s",
          now: () => 0,
        },
        onMessage: () => undefined,
      }),
    ).rejects.toThrow(/access_denied/);
  });

  it("propagates token-exchange HTTP errors", async () => {
    await expect(
      performCodexLogin({
        adapter: {
          fetch: (async () => new Response("invalid_grant", { status: 400 })) as typeof fetch,
          startServer: async () =>
            fakeServer(async () => ({ kind: "code", code: "c", state: "s" })),
          openBrowser: () => undefined,
          generateVerifier: () => "v",
          generateState: () => "s",
          now: () => 0,
        },
        onMessage: () => undefined,
      }),
    ).rejects.toThrow(/HTTP 400.*invalid_grant/);
  });
});

describe("refreshCodexToken", () => {
  it("happy path: posts refresh_token grant, returns rotated stored token", async () => {
    const newAccess = makeJwt({ chatgpt_account_id: "acc-after" });
    const fetchCalls: { url: string; body: string }[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      fetchCalls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({
          access_token: newAccess,
          refresh_token: "rt-rotated",
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const stored: StoredToken = {
      type: "oauth",
      access: "old.access.token",
      refresh: "rt-old",
      expires: 1,
      accountId: "acc-before",
      provider: "codex",
      issuedAt: 0,
    };
    const refreshed = await refreshCodexToken(stored, {
      adapter: { fetch: fetchMock, now: () => 2_000_000_000_000 },
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.body).toContain("grant_type=refresh_token");
    expect(fetchCalls[0]?.body).toContain("refresh_token=rt-old");
    expect(refreshed).toMatchObject({
      access: newAccess,
      refresh: "rt-rotated",
      accountId: "acc-after",
      issuedAt: 2_000_000_000_000,
      expires: 2_000_000_000_000 + 7200 * 1000,
    });
  });

  it("falls back to the previous refresh token when the response omits one", async () => {
    const newAccess = makeJwt({ chatgpt_account_id: "acc-z" });
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ access_token: newAccess, expires_in: 60 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const stored: StoredToken = {
      type: "oauth",
      access: "x",
      refresh: "rt-keep",
      expires: 1,
      accountId: "acc-old",
      provider: "codex",
      issuedAt: 0,
    };
    const refreshed = await refreshCodexToken(stored, {
      adapter: { fetch: fetchMock, now: () => 0 },
    });
    expect(refreshed.refresh).toBe("rt-keep");
  });

  it("throws when the stored token has no refresh", async () => {
    const stored: StoredToken = {
      type: "oauth",
      access: "x",
      provider: "codex",
      issuedAt: 0,
    };
    await expect(
      refreshCodexToken(stored, {
        adapter: {
          fetch: (async () => new Response("", { status: 200 })) as typeof fetch,
          now: () => 0,
        },
      }),
    ).rejects.toThrow(/No refresh token/);
  });

  it("throws when the stored token isn't oauth", async () => {
    const stored: StoredToken = {
      type: "api-key",
      access: "key",
      provider: "openai",
      issuedAt: 0,
    };
    await expect(
      refreshCodexToken(stored, {
        adapter: {
          fetch: (async () => new Response("", { status: 200 })) as typeof fetch,
          now: () => 0,
        },
      }),
    ).rejects.toThrow(/api-key/);
  });
});
