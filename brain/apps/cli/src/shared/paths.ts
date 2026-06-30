/**
 * Path resolution for the brain CLI.
 *
 * Two roots, kept distinct on purpose:
 *   - BRAIN_HOME (`~/brain/`) — machine-local: config, OAuth tokens,
 *     daemon logs. Different machines can have different setups.
 *     NOT git-tracked.
 *   - BRAIN_ROOT (`~/brain/memories/`) — the wiki itself. Markdown
 *     source of truth + `.cache/` derived index. The git boundary
 *     lives here. Defaults to `<home>/memories` when unset.
 *
 * Resolution order for each: CLI flag → env var → default. CLI
 * flags can be relative (resolved against cwd) or absolute.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const DEFAULT_HOME_NAME = "brain";
const DEFAULT_ROOT_SUBDIR = "memories";
const DEFAULT_SCOPE = "personal";

function resolveAgainstCwd(input: string): string {
  return isAbsolute(input) ? input : resolve(process.cwd(), input);
}

export function resolveBrainHome(input?: string): string {
  if (input !== undefined && input !== "") return resolveAgainstCwd(input);
  if (process.env.BRAIN_HOME) return resolve(process.env.BRAIN_HOME);
  return resolve(homedir(), DEFAULT_HOME_NAME);
}

export function resolveBrainPath(input?: string, homeInput?: string): string {
  if (input !== undefined && input !== "") return resolveAgainstCwd(input);
  if (process.env.BRAIN_ROOT) return resolve(process.env.BRAIN_ROOT);
  return resolve(resolveBrainHome(homeInput), DEFAULT_ROOT_SUBDIR);
}

export function resolveScope(input?: string): string {
  if (input !== undefined && input !== "") return input;
  if (process.env.BRAIN_SCOPE) return process.env.BRAIN_SCOPE;
  return DEFAULT_SCOPE;
}

/** Path to the OAuth token directory. Lives under BRAIN_HOME. chmod 700. */
export function authDir(homeDir: string): string {
  return resolve(homeDir, "auth");
}

/** Path to daemon log directory. Lives under BRAIN_HOME. */
export function logsDir(homeDir: string): string {
  return resolve(homeDir, "logs");
}

/** Path to the user's config file. Lives under BRAIN_HOME. */
export function configPath(homeDir: string): string {
  return resolve(homeDir, "config.yaml");
}
