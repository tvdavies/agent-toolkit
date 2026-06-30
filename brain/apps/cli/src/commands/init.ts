/**
 * `brain init` — scaffold a fresh brain.
 *
 * Two roots, both idempotent:
 *   - BRAIN_HOME (`~/brain/`): machine-local. Creates `auth/` and
 *     `logs/` (chmod 700). NOT git-tracked.
 *   - BRAIN_ROOT (`~/brain/memories/`): the wiki. Creates
 *     `<scope>/<type>/` plus `.cache/`. This IS the git repo when
 *     `--git` is passed.
 *
 * `--git` runs `git init` in BRAIN_ROOT (memories, never home), writes
 * a `.gitignore` with `.cache/`, and prints next-step hints. Opt-in so
 * ephemeral test brains in tmpdirs don't accidentally become repos.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MEMORY_TYPES } from "@ai-assistant/memory";
import type { ParsedArgs } from "../shared/args.js";
import { bool, flag } from "../shared/args.js";
import {
  authDir,
  logsDir,
  resolveBrainHome,
  resolveBrainPath,
  resolveScope,
} from "../shared/brain.js";

const GITIGNORE_BODY = `# brain — local-only derived state. Markdown files are the source of truth.
.cache/

# Common editor / OS noise.
.DS_Store
*.swp
.idea/
.vscode/
`;

export async function runInit(args: ParsedArgs): Promise<void> {
  const homeDir = resolveBrainHome(flag(args, "home"));
  const rootDir = resolveBrainPath(flag(args, "root"), flag(args, "home"));
  const scope = resolveScope(flag(args, "scope"));
  const useGit = bool(args, "git");
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  chmodSync(homeDir, 0o700);
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  chmodSync(rootDir, 0o700);
  const scopeDir = resolve(rootDir, scope);
  const cacheDir = resolve(rootDir, ".cache");
  const authPath = authDir(homeDir);
  const logsPath = logsDir(homeDir);

  const created: string[] = [];
  const existed: string[] = [];

  for (const type of MEMORY_TYPES) {
    const dir = resolve(scopeDir, type);
    if (existsSync(dir)) {
      existed.push(dir);
    } else {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      created.push(dir);
    }
  }
  chmodSync(scopeDir, 0o700);
  for (const type of MEMORY_TYPES) chmodSync(resolve(scopeDir, type), 0o700);
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    created.push(cacheDir);
  }
  chmodSync(cacheDir, 0o700);
  if (!existsSync(authPath)) {
    mkdirSync(authPath, { recursive: true, mode: 0o700 });
    created.push(authPath);
  }
  chmodSync(authPath, 0o700);
  if (!existsSync(logsPath)) {
    mkdirSync(logsPath, { recursive: true, mode: 0o700 });
    created.push(logsPath);
  }
  chmodSync(logsPath, 0o700);

  let gitInited = false;
  let gitignoreWritten = false;
  if (useGit) {
    const gitDir = resolve(rootDir, ".git");
    if (!existsSync(gitDir)) {
      const r = spawnSync("git", ["init", "--quiet"], { cwd: rootDir });
      if (r.status === 0) gitInited = true;
      else {
        process.stderr.write(
          `git init failed (status ${r.status}); leaving directory un-versioned.\n`,
        );
      }
    }
    const gitignorePath = resolve(rootDir, ".gitignore");
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, GITIGNORE_BODY);
      gitignoreWritten = true;
    }
  }

  process.stdout.write(`brain initialised\n`);
  process.stdout.write(`  home:    ${homeDir}    (machine-local; auth/ logs/ config.yaml)\n`);
  process.stdout.write(`  root:    ${rootDir}    (wiki — git boundary lives here)\n`);
  process.stdout.write(`  scope:   ${scope}\n`);
  process.stdout.write(`  created: ${created.length} dirs\n`);
  if (existed.length > 0) {
    process.stdout.write(`  existed: ${existed.length} dirs (left untouched)\n`);
  }
  if (useGit) {
    process.stdout.write(
      `  git:     ${gitInited ? "init done" : "already a repo (or init failed)"}\n`,
    );
    if (gitignoreWritten) process.stdout.write(`           wrote .gitignore (.cache/ excluded)\n`);
  }
  process.stdout.write(`\nNext: brain add "<a memory>" or brain query "<question>"\n`);
  if (useGit && gitInited) {
    process.stdout.write(`      cd ${rootDir} && git add . && git commit -m "init brain"\n`);
    process.stdout.write(`      git remote add origin <private-repo>; git push -u origin main\n`);
  }
}
