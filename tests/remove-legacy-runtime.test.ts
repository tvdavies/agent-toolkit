import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "..");
const script = path.join(repo, "scripts", "remove-legacy-runtime.sh");
let home = "";
let bin = "";
let log = "";

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "agent-toolkit-runtime-"));
  bin = path.join(home, "bin");
  log = path.join(home, "systemctl.log");
  await mkdir(bin);
  const fake = path.join(bin, "systemctl");
  await writeFile(fake, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\n");
  await chmod(fake, 0o755);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function run(...args: string[]) {
  return Bun.spawnSync([script, ...args], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, SYSTEMCTL_LOG: log },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function seed() {
  const unitDir = path.join(home, ".config", "systemd", "user");
  const configDir = path.join(home, ".config", "agent-toolkit");
  await mkdir(unitDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  for (const unit of ["agent-toolkit.service", "agent-toolkit-brain.service", "agent-toolkit-heartbeat.service", "agent-toolkit-heartbeat.timer"]) {
    await writeFile(path.join(unitDir, unit), "legacy\n");
  }
  await writeFile(path.join(configDir, "launch.sh"), "legacy\n");
  await writeFile(path.join(configDir, "serve.env"), "SECRET=preserve\n");
}

describe("remove-legacy-runtime.sh", () => {
  it("uses only the injected user systemctl and preserves serve.env", async () => {
    await seed();
    const result = run();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const calls = await readFile(log, "utf8");
    expect(calls).toContain("--user disable --now agent-toolkit.service");
    expect(calls).toContain("--user disable --now agent-toolkit-brain.service");
    expect(calls).toContain("--user disable --now agent-toolkit-heartbeat.timer");
    expect(calls).toContain("--user daemon-reload");
    expect(await Bun.file(path.join(home, ".config", "agent-toolkit", "serve.env")).text()).toBe("SECRET=preserve\n");
    expect(await Bun.file(path.join(home, ".config", "systemd", "user", "agent-toolkit.service")).exists()).toBe(false);
  });

  it("does not touch units or invoke systemctl in dry-run mode", async () => {
    await seed();
    const result = run("--dry-run");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("[dry-run]");
    expect(await Bun.file(log).exists()).toBe(false);
    expect(await Bun.file(path.join(home, ".config", "systemd", "user", "agent-toolkit.service")).exists()).toBe(true);
  });

  it("removes saved configuration only with --purge-config", async () => {
    await seed();
    const result = run("--purge-config");
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(await Bun.file(path.join(home, ".config", "agent-toolkit", "serve.env")).exists()).toBe(false);
  });
});
