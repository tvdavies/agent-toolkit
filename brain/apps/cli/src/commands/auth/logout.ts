/**
 * `brain auth logout --provider <name>` — delete a stored token.
 *
 * Prompts for confirmation by default. `--force` skips the prompt
 * (for scripting). Picker mode (no `--provider`) lists every
 * provider with a token and asks which to log out.
 */

import { existsSync, readdirSync } from "node:fs";
import { deleteToken } from "@ai-assistant/memory";
import { confirm, isCancel, select } from "@clack/prompts";
import type { ParsedArgs } from "../../shared/args.js";
import { bool, flag } from "../../shared/args.js";
import { authDir, resolveBrainHome } from "../../shared/brain.js";

function listProviders(authPath: string): string[] {
  if (!existsSync(authPath)) return [];
  return readdirSync(authPath)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .sort();
}

export async function runAuthLogout(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const authPath = authDir(homeDir);
  const force = bool(args, "force");
  let provider = flag(args, "provider");

  if (provider === undefined) {
    const providers = listProviders(authPath);
    if (providers.length === 0) {
      process.stdout.write(`No tokens at ${authPath} — nothing to log out.\n`);
      return;
    }
    if (!process.stdout.isTTY) {
      process.stderr.write("Pass --provider when not running in a TTY.\n");
      process.exit(2);
    }
    const picked = await select({
      message: "Which provider do you want to log out?",
      options: providers.map((p) => ({ value: p, label: p })),
    });
    if (isCancel(picked)) {
      process.stdout.write("Cancelled.\n");
      return;
    }
    provider = picked as string;
  }

  if (!force) {
    if (!process.stdout.isTTY) {
      process.stderr.write("Pass --force when not running in a TTY.\n");
      process.exit(2);
    }
    const ok = await confirm({
      message: `Delete token for "${provider}" at ${authPath}/${provider}.json?`,
      initialValue: false,
    });
    if (isCancel(ok) || ok !== true) {
      process.stdout.write("Cancelled.\n");
      return;
    }
  }

  const removed = deleteToken(authPath, provider);
  if (removed) {
    process.stdout.write(`Removed ${authPath}/${provider}.json\n`);
  } else {
    process.stdout.write(`No token for "${provider}" — nothing to do.\n`);
  }
}
