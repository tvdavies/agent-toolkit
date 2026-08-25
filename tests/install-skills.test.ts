import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "..");
const installer = path.join(repo, "scripts", "lib", "install-skills.sh");
let home = "";

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "agent-toolkit-skills-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function run(...args: string[]) {
  return Bun.spawnSync([installer, ...args], {
    cwd: repo,
    env: { ...process.env, HOME: home, AGENT_TOOLS_DIR: repo },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function namesIn(group: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(path.join(repo, "skills", group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!await Bun.file(path.join(repo, "skills", group, entry.name, "SKILL.md")).exists()) continue;
    names.push(entry.name);
  }
  return names.sort();
}

async function installedNames(): Promise<string[]> {
  return (await readdir(path.join(home, ".agents", "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

async function readLink(link: string): Promise<string> {
  return path.resolve(path.dirname(link), await readlink(link));
}

describe("install-skills.sh", () => {
  it("installs all groups into a fresh HOME and aliases Claude to the standard directory", async () => {
    const result = run();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const expected = [...await namesIn("general"), ...await namesIn("personal"), ...await namesIn("lleverage")].sort();
    expect(await installedNames()).toEqual(expected);
    expect(await readLink(path.join(home, ".claude", "skills"))).toBe(path.join(home, ".agents", "skills"));
    for (const name of expected) {
      const link = path.join(home, ".agents", "skills", name);
      expect((await readLink(link)).startsWith(path.join(repo, "skills"))).toBe(true);
    }
    expect(expected).not.toContain("_shared");
    expect(result.stdout.toString()).toContain(`Installed ${expected.length} skills`);
    const state = JSON.parse(await readFile(path.join(home, ".local", "state", "agent-toolkit", "skill-links.json"), "utf8"));
    expect(state.groups).toEqual(["general", "personal", "lleverage"]);
    expect(state.links).toHaveLength(expected.length);
    expect(state.links.map((link: { path: string }) => path.basename(link.path))).not.toContain("_shared");
  });

  it("installs only selected groups", async () => {
    const result = run("--groups", "general,personal");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(await installedNames()).toEqual([...await namesIn("general"), ...await namesIn("personal")].sort());
  });

  it("migrates old whole-directory toolkit symlinks", async () => {
    await mkdir(path.join(home, ".agents"), { recursive: true });
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await symlink(path.join(repo, "skills"), path.join(home, ".agents", "skills"));
    await symlink(path.join(repo, "skills"), path.join(home, ".claude", "skills"));
    const result = run("--groups=personal");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(await installedNames()).toEqual(await namesIn("personal"));
    expect(await readLink(path.join(home, ".claude", "skills"))).toBe(path.join(home, ".agents", "skills"));
  });

  it("refuses to overwrite unmanaged directories and symlinks", async () => {
    const agents = path.join(home, ".agents", "skills");
    await mkdir(path.join(agents, "slack"), { recursive: true });
    await writeFile(path.join(agents, "slack", "keep.txt"), "keep\n");
    let result = run("--groups=personal");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(path.join(agents, "slack", "keep.txt"), "utf8")).toBe("keep\n");

    await rm(path.join(agents, "slack"), { recursive: true });
    const elsewhere = path.join(home, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(agents, "slack"));
    result = run("--groups=personal");
    expect(result.exitCode).not.toBe(0);
    expect(await readLink(path.join(agents, "slack"))).toBe(elsewhere);
  });

  it("removes stale managed links that still point into this toolkit", async () => {
    expect(run().exitCode).toBe(0);
    const stale = path.join(home, ".agents", "skills", "linear-cli");
    expect((await lstat(stale)).isSymbolicLink()).toBe(true);
    const result = run("--groups=personal");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(await Bun.file(stale).exists()).toBe(false);
    expect(await installedNames()).toEqual(await namesIn("personal"));
  });

  it("makes no changes in dry-run mode", async () => {
    const result = run("--dry-run", "--groups=general");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("[dry-run]");
    expect(await Bun.file(path.join(home, ".agents")).exists()).toBe(false);
    expect(await Bun.file(path.join(home, ".local", "state", "agent-toolkit", "skill-links.json")).exists()).toBe(false);
  });
});
