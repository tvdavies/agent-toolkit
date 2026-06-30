import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ParsedArgs } from "../shared/args.js";
import { flag } from "../shared/args.js";
import { resolveBrainHome } from "../shared/brain.js";

const PID_FILENAME = "daemon.pid";

/** Ask the running daemon to reload at its next safe boundary. */
export async function runReload(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const pidPath = resolve(homeDir, PID_FILENAME);
  if (!existsSync(pidPath)) {
    process.stderr.write("brain reload: daemon is not running\n");
    process.exit(1);
  }
  const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    process.stderr.write(`brain reload: malformed pid file at ${pidPath}\n`);
    process.exit(1);
  }
  try {
    process.kill(pid, "SIGHUP");
    process.stdout.write(`brain reload: requested reload from daemon pid ${pid}\n`);
  } catch (err) {
    process.stderr.write(`brain reload: failed to signal daemon: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
