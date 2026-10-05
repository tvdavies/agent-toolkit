import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dir, "../..");
const skill = path.join(root, "skills/lleverage/prod-health");
const exec = promisify(execFile);

describe("prod-health", () => {
  test("assessment fixtures flag a crashloop, a 401 route spike and a failure-category jump", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "prod-health-fixtures-"));
    try {
      const { stdout } = await exec("bash", [path.join(skill, "tests/test.sh")], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LC_ALL: "C" },
        timeout: 60_000,
      });
      expect(stdout).toContain("prod-health tests passed");
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 65_000);

  test("every check is executable, documents itself and stays read-only", () => {
    const checks = readdirSync(path.join(skill, "scripts/checks"));
    expect(checks.sort()).toEqual(
      ["alerts", "deploys", "dispatch", "http", "k8s", "loki-errors", "posthog", "sentry", "workflows"].map((c) => `${c}.sh`),
    );
    for (const name of [...checks.map((c) => `checks/${c}`), "prod-health.sh", "baseline.sh"]) {
      const file = path.join(skill, "scripts", name);
      expect(statSync(file).mode & 0o111, `${name} executable`).toBeGreaterThan(0);
      const source = readFileSync(file, "utf8");
      expect(source, `${name} usage`).toMatch(/^# Usage: /m);
      // No mutating kubectl verbs or SQL writes.
      expect(source, `${name} kubectl writes`).not.toMatch(/kubectl[^\n|]*\b(apply|delete|patch|edit|scale|rollout (undo|restart)|annotate|label|create)\b/);
      expect(source, `${name} SQL writes`).not.toMatch(/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|DROP TABLE|ALTER TABLE)\b/);
    }
    const pg = readFileSync(path.join(skill, "scripts/lib/pgro.sh"), "utf8");
    expect(pg).toContain("default_transaction_read_only=on");
  });

  test("the workstream compatibility shim delegates to the skill", () => {
    const shim = readFileSync(path.join(root, "skills/lleverage/workstream/scripts/prod-health.sh"), "utf8");
    expect(shim).toContain("../../prod-health/scripts/prod-health.sh");
  });
});
