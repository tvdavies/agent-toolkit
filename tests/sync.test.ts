import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "..");
const syncScript = path.join(repo, "scripts", "sync.sh");
let home = "";
let fakeBin = "";
let commandLog = "";

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "agent-toolkit-sync-"));
  fakeBin = path.join(home, "bin");
  commandLog = path.join(home, "commands.log");
  await mkdir(fakeBin, { recursive: true });
  for (const command of ["npm", "pi"]) {
    const executable = path.join(fakeBin, command);
    await writeFile(executable, `#!/usr/bin/env bash\nprintf '${command} %s\\n' "$*" >> "$SYNC_COMMAND_LOG"\n`);
    await chmod(executable, 0o755);
  }
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function runSync(...args: string[]) {
  return Bun.spawnSync([syncScript, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: home,
      AGENT_TOOLS_DIR: repo,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      SYNC_COMMAND_LOG: commandLog,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function loggedCommands(): Promise<string[]> {
  return (await readFile(commandLog, "utf8")).trim().split("\n").filter(Boolean);
}

async function installedSkillNames(): Promise<string[]> {
  return (await readdir(path.join(home, ".agents", "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

async function readSkillState(): Promise<{ repo: string; groups: string[] }> {
  return JSON.parse(await readFile(path.join(home, ".local", "state", "agent-toolkit", "skill-links.json"), "utf8"));
}

describe("scripts/sync.sh", () => {
  it("reconciles dependencies, skills, the local package, workflows, and manifest packages", async () => {
    const result = runSync("--groups=general");
    expect(result.exitCode, result.stderr.toString()).toBe(0);

    const commands = await loggedCommands();
    expect(commands).toContain(`npm ci --omit=dev --prefix ${repo}`);
    expect(commands).toContain(`pi install ${repo}`);

    const manifest = JSON.parse(await readFile(path.join(repo, "manifests", "pi-packages.json"), "utf8"));
    for (const packageSpec of manifest.packages as string[]) {
      expect(commands).toContain(`pi install ${packageSpec}`);
    }
    expect(commands).not.toContain("pi update --extensions");

    const generalSkills = (await readdir(path.join(repo, "skills", "general"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .filter((entry) => Bun.file(path.join(repo, "skills", "general", entry.name, "SKILL.md")).size > 0)
      .map((entry) => entry.name)
      .sort();
    expect(await installedSkillNames()).toEqual(generalSkills);
    expect(path.resolve(path.join(home, ".claude"), await readlink(path.join(home, ".claude", "skills")))).toBe(
      path.join(home, ".agents", "skills"),
    );

    for (const workflow of ["debug-issue.ts", "implement-ticket.ts", "review-pr.ts"]) {
      const link = path.join(home, ".pi", "agent", "workflows", workflow);
      expect(path.resolve(path.dirname(link), await readlink(link))).toBe(path.join(repo, ".pi", "workflows", workflow));
    }
    expect(result.stdout.toString()).toContain("Run /reload in active Pi sessions");
  });

  it("uses all groups on first install and updates Pi extensions only when explicitly requested", async () => {
    const result = runSync("--update-pi-packages");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect((await readSkillState()).groups).toEqual(["general", "personal", "lleverage"]);
    expect(await loggedCommands()).toContain("pi update --extensions");
  });

  it("preserves a selective managed group set when a later hook-style run omits --groups", async () => {
    const first = runSync("--groups=general,personal");
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const selectedNames = await installedSkillNames();
    expect((await readSkillState()).groups).toEqual(["general", "personal"]);

    const second = runSync();
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(second.stdout.toString()).toContain("Reusing managed skill groups for this checkout: general,personal");
    expect((await readSkillState()).groups).toEqual(["general", "personal"]);
    expect(await installedSkillNames()).toEqual(selectedNames);

    const allGroups = runSync("--groups", "general,personal,lleverage");
    expect(allGroups.exitCode, allGroups.stderr.toString()).toBe(0);
    expect((await readSkillState()).groups).toEqual(["general", "personal", "lleverage"]);
    expect(await installedSkillNames()).toContain("linear-cli");
  });

  it("fails clearly instead of replacing malformed managed groups for this checkout", async () => {
    const stateDir = path.join(home, ".local", "state", "agent-toolkit");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "skill-links.json"),
      `${JSON.stringify({ version: 1, repo, groups: ["general", "unknown"], links: [] }, null, 2)}\n`,
    );

    const result = runSync();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("contains an invalid skill group");
    expect(await Bun.file(path.join(home, ".agents", "skills")).exists()).toBe(false);

    const repair = runSync("--groups=general");
    expect(repair.exitCode, repair.stderr.toString()).toBe(0);
    expect((await readSkillState()).groups).toEqual(["general"]);
  });
});

describe("script compatibility and hooks", () => {
  it("keeps legacy entrypoints as thin sync.sh shims", async () => {
    for (const name of ["install.sh", "after-pull.sh"]) {
      const source = await readFile(path.join(repo, "scripts", name), "utf8");
      expect(source).toContain('exec "$SCRIPT_DIR/sync.sh" "$@"');
      expect(source).not.toContain("bootstrap.sh");
    }
  });

  it("generates merge and rebase hooks that call sync.sh directly", async () => {
    const gitRepo = path.join(home, "hook-repo");
    await mkdir(gitRepo);
    const init = Bun.spawnSync(["git", "init", "-q", gitRepo], { stdout: "pipe", stderr: "pipe" });
    expect(init.exitCode, init.stderr.toString()).toBe(0);

    const install = Bun.spawnSync([path.join(repo, "scripts", "lib", "install-git-hooks.sh")], {
      cwd: repo,
      env: { ...process.env, HOME: home, AGENT_TOOLS_DIR: gitRepo },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(install.exitCode, install.stderr.toString()).toBe(0);

    for (const name of ["post-merge", "post-rewrite"]) {
      const source = await readFile(path.join(gitRepo, ".git", "hooks", name), "utf8");
      expect(source).toContain('"$REPO_DIR/scripts/sync.sh"');
      expect(source).toContain("Run $REPO_DIR/scripts/sync.sh manually");
      expect(source).not.toContain("after-pull.sh");
      expect(source).not.toContain("bootstrap.sh");
    }
  });
});
