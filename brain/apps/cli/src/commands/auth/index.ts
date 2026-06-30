/**
 * `brain auth <subcommand>` dispatch.
 *
 * Subcommands: login | status | logout | refresh.
 *
 * The first positional after `auth` is treated as the subcommand;
 * remaining flags pass through. We don't use commander/yargs here —
 * the shared args parser already gave us what we need.
 */

import type { ParsedArgs } from "../../shared/args.js";
import { runAuthLogin } from "./login.js";
import { runAuthLogout } from "./logout.js";
import { runAuthRefresh } from "./refresh.js";
import { runAuthStatus } from "./status.js";
import { runAuthTest } from "./test.js";

const HELP = `brain auth — manage provider credentials

Usage:
  brain auth login [--provider <name>] [--key <key>] [--base-url <url>]
  brain auth status [--json]
  brain auth refresh --provider <name>
  brain auth logout [--provider <name>] [--force]
  brain auth test [--provider <name>] [--model <id>] [--prompt <text>]

With no --provider, \`login\` and \`logout\` open an interactive picker.
\`test\` defaults to --provider codex --model gpt-5.1-codex-mini.
`;

export async function runAuth(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0] ?? "";
  // The auth dispatcher consumes the first positional, leaving the rest
  // (and all flags) intact for subcommand handlers via the same args.
  const subArgs: ParsedArgs = { ...args, positional: args.positional.slice(1) };

  switch (sub) {
    case "login":
      await runAuthLogin(subArgs);
      return;
    case "status":
      await runAuthStatus(subArgs);
      return;
    case "logout":
      await runAuthLogout(subArgs);
      return;
    case "refresh":
      await runAuthRefresh(subArgs);
      return;
    case "test":
      await runAuthTest(subArgs);
      return;
    case "":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`Unknown auth subcommand: ${sub}\n\n${HELP}`);
      process.exit(2);
  }
}
