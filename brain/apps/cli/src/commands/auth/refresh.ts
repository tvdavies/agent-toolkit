/**
 * `brain auth refresh --provider <name>` — force a token refresh.
 *
 * No-op for `api-key` providers (nothing to refresh). For `oauth` it
 * exchanges the refresh token for a fresh access token. The dance is
 * provider-specific — codex lands in BRAIN-112.
 */

import { readToken, refreshCodexToken, withTokenLock, writeToken } from "@ai-assistant/memory";
import type { ParsedArgs } from "../../shared/args.js";
import { bool, flag } from "../../shared/args.js";
import { authDir, resolveBrainHome } from "../../shared/brain.js";

export async function runAuthRefresh(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const authPath = authDir(homeDir);
  const provider = flag(args, "provider");
  const json = bool(args, "json");
  if (provider === undefined) {
    process.stderr.write("Pass --provider <name>.\n");
    process.exit(2);
  }
  const token = readToken(authPath, provider);
  if (token === null) {
    process.stderr.write(
      `No token at ${authPath}/${provider}.json. Run \`brain auth login --provider ${provider}\`.\n`,
    );
    process.exit(2);
  }
  if (token.type === "api-key") {
    process.stdout.write(`${provider}: api-key — nothing to refresh.\n`);
    return;
  }
  if (provider !== "codex") {
    process.stderr.write(
      `OAuth refresh for "${provider}" is not implemented (only codex is wired today).\n`,
    );
    process.exit(2);
  }
  try {
    const refreshed = await withTokenLock(authPath, provider, async () => {
      const fresh = await refreshCodexToken(token);
      writeToken(authPath, fresh);
      return fresh;
    });
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            provider,
            accountId: refreshed.accountId,
            expiresAt: new Date(refreshed.expires ?? 0).toISOString(),
            rotatedRefresh: refreshed.refresh !== token.refresh,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    process.stdout.write(
      `Refreshed ${provider}: expires ${new Date(refreshed.expires ?? 0).toISOString()}` +
        `${refreshed.refresh !== token.refresh ? " (rotated refresh token)" : ""}\n`,
    );
  } catch (err) {
    process.stderr.write(`Refresh failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
