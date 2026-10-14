import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const queue = path.join(root, "skills/lleverage/workstream/scripts/linear-queue.sh");

const todo = { name: "To Do", type: "unstarted" };
const base = { priority: 3, url: "u", labels: { nodes: [] }, project: null, cycle: { number: 1 }, inverseRelations: { nodes: [] }, children: { nodes: [] } };
const issues = [
  { ...base, identifier: "LLE-1", title: "Sized by estimate", estimate: 3, state: todo, assignee: { name: "Tom Davies", isMe: true }, parent: null, description: "**Status:** Ready (12 Oct)\n\nSize: S" },
  { ...base, identifier: "LLE-2", title: "Sized by description", estimate: null, state: todo, assignee: null, parent: { identifier: "LLE-9", state: { name: "Done", type: "completed" }, parent: null }, description: "**Status:** Needs decision (12 Oct)\n\n**Size:** M (one PR)" },
  { ...base, identifier: "LLE-3", title: "Open parent", estimate: 8, state: todo, assignee: { name: "Alex", isMe: false }, parent: { identifier: "LLE-8", state: todo, parent: null }, description: null },
];

describe("linear-queue.sh --json", () => {
  test("reports size, the prepare-ticket verdict, the assignee and whether any ancestor is open", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "linear-queue-"));
    try {
      writeFileSync(path.join(dir, "issues.json"), JSON.stringify({ data: { issues: { pageInfo: { hasNextPage: false }, nodes: issues } } }));
      writeFileSync(path.join(dir, "linear-cli"), '#!/usr/bin/env bash\ncat "$FAKE_ISSUES"\n');
      writeFileSync(path.join(dir, "gh"), "#!/usr/bin/env bash\necho '[]'\n");
      chmodSync(path.join(dir, "linear-cli"), 0o755);
      chmodSync(path.join(dir, "gh"), 0o755);
      const result = spawnSync("bash", [queue, "cycle", "--all-assignees", "--json"], {
        env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, FAKE_ISSUES: path.join(dir, "issues.json") },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const rows = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
      const by = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(by["LLE-1"]).toMatchObject({ size: "M", prepared: "Ready", assignedToMe: true, openAncestor: false, stateType: "unstarted", verdict: "eligible" });
      expect(by["LLE-2"]).toMatchObject({ size: "M", prepared: "Needs decision", assignee: null, assignedToMe: false, openAncestor: false });
      expect(by["LLE-3"]).toMatchObject({ size: "XL", prepared: null, assignee: "Alex", openAncestor: true, verdict: "eligible" });
      expect(rows[0]).not.toHaveProperty("description");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("linear-queue.sh parked", () => {
  test("reads Testing tickets with their staging-test markers, oldest first, one per comment", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "linear-queue-"));
    try {
      const comments = [
        { createdAt: "2026-10-13T12:00:00.000Z", body: "Tom approved the reset.\nstaging-test:reset-approved staging=aaaa1111" },
        { createdAt: "2026-10-13T10:00:00.000Z", body: "Staging check for #8514 at abc1234: reset needed.\n\n- Why: ...\n\n`staging-test:reset-needed pr=8514 staging=aaaa1111 main=bbbb2222`" },
        { createdAt: "2026-10-13T09:00:00.000Z", body: "We could use staging-test: later" },
      ];
      const node = { identifier: "LLE-5", title: "Parked", url: "u", priority: 2, state: { name: "Testing", type: "started" }, assignee: null, comments: { nodes: comments } };
      writeFileSync(path.join(dir, "issues.json"), JSON.stringify({ data: { issues: { pageInfo: { hasNextPage: false }, nodes: [node] } } }));
      writeFileSync(path.join(dir, "linear-cli"), '#!/usr/bin/env bash\necho "$*" > "$FAKE_ARGS"\ncat "$FAKE_ISSUES"\n');
      writeFileSync(path.join(dir, "gh"), "#!/usr/bin/env bash\necho '[]'\n");
      chmodSync(path.join(dir, "linear-cli"), 0o755);
      chmodSync(path.join(dir, "gh"), 0o755);
      const result = spawnSync("bash", [queue, "parked"], {
        env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, FAKE_ISSUES: path.join(dir, "issues.json"), FAKE_ARGS: path.join(dir, "args") },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const [row] = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(row).toMatchObject({ id: "LLE-5", state: "Testing", assignee: null, assignedToMe: false });
      expect(row.markers).toEqual([
        { kind: "reset-needed", at: "2026-10-13T10:00:00.000Z", attrs: { pr: "8514", staging: "aaaa1111", main: "bbbb2222" } },
        { kind: "reset-approved", at: "2026-10-13T12:00:00.000Z", attrs: { staging: "aaaa1111" } },
      ]);
      const args = readFileSync(path.join(dir, "args"), "utf8");
      expect(args).toContain('state:{name:{eq:"Testing"}}');
      expect(args).toContain('body:{contains:"staging-test:"}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
