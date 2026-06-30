/**
 * Localhost callback server for the OAuth dance.
 *
 * Default port 1455 (matching Pi). Override with the `port` arg or
 * `BRAIN_OAUTH_CALLBACK_PORT` env. If the requested port is in use,
 * we fall back to OS-assigned ephemeral (port 0) and report which
 * URL we ended up on so the caller can use that as `redirect_uri`.
 *
 * The server only handles GET /auth/callback. Anything else returns
 * 404. On success it returns a small HTML page so the user sees
 * something rather than a blank tab.
 */

const CALLBACK_PATH = "/auth/callback";

const SUCCESS_HTML = `<!doctype html>
<html><head><title>brain — signed in</title>
<style>body{font:14px/1.4 system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#222}h1{font-size:18px}</style>
</head><body><h1>Signed in.</h1><p>You can close this tab and return to the terminal.</p></body></html>`;

const FAIL_HTML = (msg: string): string =>
  `<!doctype html><html><head><title>brain — sign-in failed</title>
<style>body{font:14px/1.4 system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#222}h1{font-size:18px;color:#a33}</style>
</head><body><h1>Sign-in failed</h1><p>${msg.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c)}</p>
<p>Return to the terminal — you can retry with <code>brain auth login --provider codex</code>.</p></body></html>`;

export type CallbackResult =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; error: string; description?: string };

export type CallbackServer = {
  /** Full redirect URL the server is listening on. */
  url: string;
  /** Port (useful if we fell back to ephemeral). */
  port: number;
  /** Resolves with the first callback received (whether code or error). */
  receive: () => Promise<CallbackResult>;
  /** Stop accepting new connections; idempotent. */
  close: () => Promise<void>;
};

export type StartCallbackServerOptions = {
  port?: number;
  /** Override `Bun.serve`. Mostly for tests. */
  serve?: typeof Bun.serve;
};

export async function startCallbackServer(
  opts: StartCallbackServerOptions = {},
): Promise<CallbackServer> {
  const requestedPort = opts.port ?? 1455;
  const serveImpl = opts.serve ?? Bun.serve;

  let resolveCallback: ((result: CallbackResult) => void) | undefined;
  let captured: CallbackResult | undefined;
  const promise = new Promise<CallbackResult>((res) => {
    resolveCallback = (r) => {
      if (captured !== undefined) return;
      captured = r;
      res(r);
    };
  });

  const handler = (req: Request): Response => {
    const url = new URL(req.url);
    if (url.pathname !== CALLBACK_PATH) {
      return new Response("Not found", { status: 404 });
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description") ?? undefined;
    if (error !== null) {
      const result: CallbackResult =
        errorDescription !== undefined
          ? { kind: "error", error, description: errorDescription }
          : { kind: "error", error };
      resolveCallback?.(result);
      return new Response(FAIL_HTML(error), {
        status: 400,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (code !== null && state !== null) {
      resolveCallback?.({ kind: "code", code, state });
      return new Response(SUCCESS_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Callback missing both `code` and `error` query params", {
      status: 400,
    });
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = serveImpl({ port: requestedPort, fetch: handler });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // Fall back to ephemeral.
      server = serveImpl({ port: 0, fetch: handler });
    } else {
      throw err;
    }
  }

  // Bun.serve always binds to a concrete port; the type is only optional
  // because some transports (unix sockets) don't have one. Cast loud
  // rather than `?? 0` so a future regression actually crashes.
  const boundPort = server.port;
  if (typeof boundPort !== "number") {
    throw new Error("callback server bound to a non-port transport — cannot continue");
  }
  return {
    url: `http://localhost:${boundPort}${CALLBACK_PATH}`,
    port: boundPort,
    receive: () => promise,
    async close() {
      await server.stop();
    },
  };
}
