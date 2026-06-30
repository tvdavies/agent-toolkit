/**
 * `brain auth login` — interactive picker, dispatches to the right
 * flow (subscription OAuth or API-key).
 *
 *   brain auth login                           → picker
 *   brain auth login --provider codex          → straight to OAuth
 *   brain auth login --provider anthropic      → straight to API-key prompt
 *   brain auth login --provider openai --key … → fully non-interactive
 *
 * The OAuth flow for codex isn't wired yet — that lands in BRAIN-112.
 * For now it shows a "not implemented" notice but keeps the API-key
 * flows functional so users can save anthropic / openai / custom-gateway
 * keys today.
 */

import {
  performCodexLogin,
  type StoredToken,
  withTokenLock,
  writeToken,
} from "@ai-assistant/memory";
import { intro, isCancel, outro, password, select, text } from "@clack/prompts";
import type { ParsedArgs } from "../../shared/args.js";
import { flag } from "../../shared/args.js";
import { authDir, resolveBrainHome } from "../../shared/brain.js";

type Choice = "codex" | "anthropic" | "openai" | "openai-compatible";

const CHOICES: Array<{ value: Choice; label: string; hint: string }> = [
  {
    value: "codex",
    label: "Subscription (OpenAI Codex)",
    hint: "uses your ChatGPT plan via OAuth — no per-token API costs",
  },
  {
    value: "anthropic",
    label: "API key — Anthropic (direct)",
    hint: "claude-* models, billed per token to your Anthropic account",
  },
  {
    value: "openai",
    label: "API key — OpenAI (direct)",
    hint: "gpt-* models, billed per token to your OpenAI account",
  },
  {
    value: "openai-compatible",
    label: "API key — Custom gateway / OpenAI-compatible",
    hint: "Vercel AI Gateway, vLLM, Ollama, Together, Groq, Mistral, …",
  },
];

export async function runAuthLogin(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const authPath = authDir(homeDir);

  let provider = flag(args, "provider") as Choice | undefined;
  const inlineKey = flag(args, "key");

  // Non-interactive path with all flags supplied.
  if (provider !== undefined && inlineKey !== undefined) {
    await persistApiKey({
      authPath,
      provider,
      key: inlineKey,
      ...(flag(args, "base-url") !== undefined
        ? { baseUrl: flag(args, "base-url") as string }
        : {}),
    });
    return;
  }

  // Interactive picker if no --provider.
  if (provider === undefined) {
    if (!process.stdout.isTTY) {
      process.stderr.write(
        "Pass --provider when not running in a TTY. Try `--provider codex` or `--provider openai --key <key>`.\n",
      );
      process.exit(2);
    }
    intro("brain auth login");
    const picked = await select({
      message: "How would you like to authenticate?",
      options: CHOICES.map((c) => ({ value: c.value, label: c.label, hint: c.hint })),
    });
    if (isCancel(picked)) {
      outro("Cancelled.");
      return;
    }
    provider = picked as Choice;
  }

  if (provider === "codex") {
    await runCodexLogin(authPath);
    return;
  }

  // API-key flows
  if (!process.stdout.isTTY) {
    process.stderr.write("Pass --key when not running in a TTY.\n");
    process.exit(2);
  }
  const key = await password({
    message: `Paste the API key for ${provider}`,
    validate: (v) => (!v || v.length === 0 ? "Key cannot be empty." : undefined),
  });
  if (isCancel(key)) {
    outro("Cancelled.");
    return;
  }
  let baseUrl: string | undefined;
  if (provider === "openai-compatible") {
    const u = await text({
      message: "Base URL (e.g. https://gateway.example.com/v1)",
      validate: (v) => {
        if (!v || v.length === 0) return "Base URL cannot be empty.";
        try {
          new URL(v);
        } catch {
          return "Not a valid URL.";
        }
        return undefined;
      },
    });
    if (isCancel(u)) {
      outro("Cancelled.");
      return;
    }
    baseUrl = u as string;
  }

  await persistApiKey({
    authPath,
    provider,
    key: key as string,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
  outro(`Saved ${authPath}/${provider}.json`);
}

async function runCodexLogin(authPath: string): Promise<void> {
  // Plain stdout writes — no clack spinner. The spinner buffers
  // output (so the authorize URL wouldn't appear until after the
  // callback returns), and "waiting for browser" is just a message,
  // not a thing the user can interact with.
  let token: StoredToken;
  try {
    token = await withTokenLock(authPath, "codex", () =>
      performCodexLogin({
        onMessage: (msg) => process.stdout.write(`${msg}\n`),
      }),
    );
  } catch (err) {
    process.stderr.write(`Sign-in failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
  writeToken(authPath, token);
  process.stdout.write(`Saved ${authPath}/codex.json — account ${token.accountId ?? "?"}\n`);
}

async function persistApiKey(opts: {
  authPath: string;
  provider: string;
  key: string;
  baseUrl?: string;
}): Promise<void> {
  const token: StoredToken = {
    type: "api-key",
    access: opts.key,
    provider: opts.provider,
    issuedAt: Date.now(),
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
  };
  writeToken(opts.authPath, token);
  if (!process.stdout.isTTY) {
    process.stdout.write(`Saved ${opts.authPath}/${opts.provider}.json (chmod 600)\n`);
  }
}
