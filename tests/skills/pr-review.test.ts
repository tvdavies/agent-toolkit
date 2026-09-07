import { describe, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dir, "../..");
const skill = path.join(root, "skills/general/pr-review");
const exec = promisify(execFile);

describe("PR review artefacts and posting", () => {
  test("concurrent runs allocate private unique directories and never overwrite each other", async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "pr-review-concurrency-"));
    try {
      const dirs = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
        const { stdout } = await exec("bash", [path.join(skill, "scripts/review-tmpdir.sh")], {
          env: { PATH: process.env.PATH, TMPDIR: temp },
        });
        const directory = stdout.trim();
        writeFileSync(path.join(directory, "pr.diff"), `diff-${index}`);
        writeFileSync(path.join(directory, "pr-review.md"), `report-${index}`);
        return directory;
      }));
      expect(new Set(dirs).size).toBe(12);
      dirs.forEach((directory, index) => {
        expect(path.dirname(directory)).toBe(temp);
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        expect(readFileSync(path.join(directory, "pr.diff"), "utf8")).toBe(`diff-${index}`);
        expect(readFileSync(path.join(directory, "pr-review.md"), "utf8")).toBe(`report-${index}`);
      });
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  test("explicit caller directory is reused, including spaces and quotes", () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "pr-review-explicit-"));
    try {
      const explicit = path.join(temp, "caller's review");
      const run = () => execFileSync("bash", [path.join(skill, "scripts/review-tmpdir.sh")], {
        env: { PATH: process.env.PATH, PR_REVIEW_TMPDIR: explicit, TMPDIR: temp }, encoding: "utf8",
      }).trim();
      expect(run()).toBe(explicit);
      writeFileSync(path.join(explicit, "caller-owned"), "keep");
      expect(run()).toBe(explicit);
      expect(readFileSync(path.join(explicit, "caller-owned"), "utf8")).toBe("keep");
      expect(readdirSync(temp)).toEqual(["caller's review"]);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  test("posting shell fixtures run under npm test with mocked gh and isolated home", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "pr-post-fixtures-"));
    try {
      // No credentials/config inherited. The fixture prepends a fail-closed fake
      // gh to PATH; every simulated publication is local file output only.
      const { stdout } = await exec("bash", [path.join(skill, "tests/post-review-result.test.sh")], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LC_ALL: "C" },
        timeout: 60_000,
      });
      expect(stdout).toContain("post-review result tests passed");
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 65_000);
});
