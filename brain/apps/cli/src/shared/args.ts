/**
 * Tiny argv parser. We avoid commander/yargs to keep the CLI
 * surface small; the operations are simple enough that
 * hand-parsing stays readable.
 *
 * Conventions:
 *   - `--flag` is boolean true.
 *   - `--key value` and `--key=value` both work.
 *   - Repeated flags overwrite (last wins).
 *   - The first non-flag argument is the subcommand; remaining
 *     positionals are the subcommand's positional arguments.
 */

export type ParsedArgs = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command = "";

  let i = 0;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        i++;
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
        continue;
      }
      flags[key] = true;
      i++;
      continue;
    }
    if (command === "") {
      command = a;
    } else {
      positional.push(a);
    }
    i++;
  }
  return { command, positional, flags };
}

export function flag(args: ParsedArgs, name: string, fallback?: string): string | undefined {
  const v = args.flags[name];
  if (typeof v === "string") return v;
  return fallback;
}

export function bool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

export function intFlag(args: ParsedArgs, name: string, fallback: number): number {
  const v = args.flags[name];
  if (typeof v !== "string") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}
