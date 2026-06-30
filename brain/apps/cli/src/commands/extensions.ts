import { discoverExtensions, trustExtension, validateExtensions } from "@ai-assistant/brain-core";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag } from "../shared/args.js";
import { resolveBrainHome, resolveBrainPath } from "../shared/brain.js";

const HELP = `brain extensions — manage brain extensions

Usage:
  brain extensions list [--json]
  brain extensions validate [--json]
  brain extensions trust <path>

Extensions are discovered from:
  <home>/extensions/*.ts
  <home>/extensions/*/index.ts
  <root>/.brain/extensions/*.ts
  <root>/.brain/extensions/*/index.ts
`;

export async function runExtensions(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0] ?? "list";
  const subArgs: ParsedArgs = { ...args, positional: args.positional.slice(1) };
  switch (sub) {
    case "list":
      await runList(subArgs);
      return;
    case "validate":
      await runValidate(subArgs);
      return;
    case "trust":
      await runTrust(subArgs);
      return;
    case "help":
    case "":
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`Unknown extensions subcommand: ${sub}\n\n${HELP}`);
      process.exit(2);
  }
}

async function runList(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const extensions = await discoverExtensions({ homeDir, rootDir });
  if (bool(args, "json")) {
    process.stdout.write(`${JSON.stringify({ homeDir, rootDir, extensions }, null, 2)}\n`);
    return;
  }
  if (extensions.length === 0) {
    process.stdout.write("No extensions found.\n");
    return;
  }
  for (const ext of extensions) {
    const trust = ext.trusted ? "trusted" : "untrusted";
    process.stdout.write(
      `${ext.scope.padEnd(7)} ${ext.origin.padEnd(9)} ${trust.padEnd(9)} ${ext.path}\n`,
    );
  }
}

async function runTrust(args: ParsedArgs): Promise<void> {
  const target = args.positional[0];
  if (target === undefined) {
    process.stderr.write("Usage: brain extensions trust <path>\n");
    process.exit(2);
  }
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  await trustExtension({ homeDir, rootDir }, target);
  process.stdout.write(`trusted ${target}\n`);
}

async function runValidate(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const results = await validateExtensions({ homeDir, rootDir });
  if (bool(args, "json")) {
    process.stdout.write(`${JSON.stringify({ homeDir, rootDir, results }, null, 2)}\n`);
    return;
  }
  let failed = 0;
  for (const result of results) {
    if (result.ok) {
      const caps = result.capabilities?.join(",") ?? "none";
      const trust = result.trusted ? "trusted" : "untrusted";
      process.stdout.write(
        `ok     ${result.path}\n       ${result.name}@${result.version} capabilities=${caps} trust=${trust}\n`,
      );
    } else {
      failed++;
      process.stdout.write(`failed ${result.path}\n       ${result.error}\n`);
    }
  }
  if (failed > 0) process.exit(1);
}
