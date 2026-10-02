import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dir, "../..");
const skill = path.join(root, "skills/general/review-queue");
const exec = promisify(execFile);

describe("review queue", () => {
  test("queue shell fixtures run with mocked gh and isolated home", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "review-queue-fixtures-"));
    try {
      // The fixture prepends a fake gh to PATH; no GitHub access occurs.
      const { stdout } = await exec("bash", [path.join(skill, "tests/review-queue.test.sh")], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LC_ALL: "C" },
        timeout: 60_000,
      });
      expect(stdout).toContain("review queue tests passed");
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 65_000);
});
