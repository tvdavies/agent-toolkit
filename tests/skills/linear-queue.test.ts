import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const readyFrom = (identifier: string, status: string) => ({ ...base, identifier, title: status, estimate: 1, state: todo, assignee: null, parent: null, description: `**Status:** ${status}\n\nSize: XS` });
const datedIssues = [
  readyFrom("LLE-4", "Ready from 14 Nov 2099."),
  readyFrom("LLE-5", "Ready from 2099-11-14"),
  readyFrom("LLE-6", "Ready from 14 November 2020"),
  readyFrom("LLE-7", "Ready from 2020-11-14"),
  readyFrom("LLE-8", "Ready from next month"),
  readyFrom("LLE-9", "Ready from 30 Feb 2020"),
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
      expect(by["LLE-1"].readyFrom).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Ready from a future or unreadable date is Ready later; from a past date it is Ready", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "linear-queue-"));
    try {
      writeFileSync(path.join(dir, "issues.json"), JSON.stringify({ data: { issues: { pageInfo: { hasNextPage: false }, nodes: datedIssues } } }));
      writeFileSync(path.join(dir, "linear-cli"), '#!/usr/bin/env bash\ncat "$FAKE_ISSUES"\n');
      writeFileSync(path.join(dir, "gh"), "#!/usr/bin/env bash\necho '[]'\n");
      chmodSync(path.join(dir, "linear-cli"), 0o755);
      chmodSync(path.join(dir, "gh"), 0o755);
      const result = spawnSync("bash", [queue, "cycle", "--all-assignees", "--json"], {
        env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, FAKE_ISSUES: path.join(dir, "issues.json") },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const by = Object.fromEntries(result.stdout.trim().split("\n").map((line) => JSON.parse(line)).map((row) => [row.id, row]));
      expect(by["LLE-4"]).toMatchObject({ prepared: "Ready later", readyFrom: "2099-11-14" });
      expect(by["LLE-5"]).toMatchObject({ prepared: "Ready later", readyFrom: "2099-11-14" });
      expect(by["LLE-6"]).toMatchObject({ prepared: "Ready", readyFrom: "2020-11-14" });
      expect(by["LLE-7"]).toMatchObject({ prepared: "Ready", readyFrom: "2020-11-14" });
      expect(by["LLE-8"]).toMatchObject({ prepared: "Ready later", readyFrom: null });
      expect(by["LLE-9"]).toMatchObject({ prepared: "Ready later", readyFrom: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
