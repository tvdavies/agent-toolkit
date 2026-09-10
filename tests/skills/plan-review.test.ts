import { expect, test } from "bun:test";

const root = new URL("../..", import.meta.url).pathname;
test("plan review CLI regression suite uses fake HTTP and isolated credentials", () => {
  const result = Bun.spawnSync(["bash", `${root}/skills/personal/plan-review/tests/plan-review.test.sh`], {
    cwd: root, env: { PATH: process.env.PATH ?? "", HOME: "/tmp" }, timeout: 30_000,
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("PASS:");
});
