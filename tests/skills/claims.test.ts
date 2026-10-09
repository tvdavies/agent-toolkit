import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const claimScript = join(root, "skills/general/claims/scripts/claim.mjs");
const wrapper = join(root, "skills/general/claims/scripts/claim");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "claims-test-"));
  tempDirs.push(dir);
  return join(dir, "nested", "claims.db");
}

type Result = { status: number; stdout: string; stderr: string; json: any };

function claimEnv(db: string, at?: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== "AGENT_CLAIMS_NOW") env[name] = value;
  }
  env.AGENT_CLAIMS_DB = db;
  if (at !== undefined) env.AGENT_CLAIMS_NOW = String(at);
  return env;
}

function claim(db: string, args: string[], at?: number): Result {
  const result = spawnSync("node", [claimScript, ...args, "--json"], { encoding: "utf8", env: claimEnv(db, at) });
  let json: any = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {}
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, json };
}

function claimAsync(db: string, args: string[]): Promise<Result> {
  return new Promise((done) => {
    const child = spawn("node", [claimScript, ...args, "--json"], {
      env: claimEnv(db),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      done({ status: status ?? -1, stdout, stderr, json });
    });
  });
}

function history(db: string): Array<Record<string, unknown>> {
  const script = `
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    console.log(JSON.stringify(db.prepare("SELECT * FROM history ORDER BY id").all()));`;
  const result = spawnSync("node", ["--input-type=module", "-e", script, db], { encoding: "utf8" });
  return JSON.parse(result.stdout);
}

const T0 = Date.parse("2026-10-09T10:00:00Z");
const MIN = 60_000;

describe("claim CLI", () => {
  for (const scenario of ["a fresh database", "an existing database"]) {
    it(`lets exactly one of many parallel processes acquire a key (${scenario})`, async () => {
      const db = tempDb();
      if (scenario === "an existing database") expect(claim(db, ["list"]).status).toBe(0);
      const n = 16;
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) => claimAsync(db, ["acquire", "main:lleverage-ai/lleverage", "--holder", `racer ${i}`])),
      );
      const winners = results.filter((r) => r.status === 0);
      const losers = results.filter((r) => r.status === 3);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(n - 1);
      const winner = winners[0]!.json.claim.holder;
      for (const loser of losers) expect(loser.json.claim.holder).toBe(winner);
      expect(claim(db, ["show", "main:lleverage-ai/lleverage"]).json.claim.holder).toBe(winner);
      expect(history(db).filter((row) => row.action === "acquire")).toHaveLength(1);
    }, 30_000);
  }

  it("makes re-acquire by the same holder idempotent and keeps acquired_at", () => {
    const db = tempDb();
    const first = claim(db, ["acquire", "ticket:LLE-1", "--holder", "a", "--note", "first"], T0);
    expect(first.status).toBe(0);
    expect(first.json.status).toBe("acquired");
    const again = claim(db, ["acquire", "ticket:LLE-1", "--holder", "a"], T0 + 5 * MIN);
    expect(again.status).toBe(0);
    expect(again.json.status).toBe("renewed");
    expect(again.json.claim.acquired_at).toBe(first.json.claim.acquired_at);
    expect(again.json.claim.note).toBe("first");
    expect(Date.parse(again.json.claim.expires_at)).toBe(T0 + 20 * MIN);
  });

  it("reports the holder with exit 3 and lets another holder take over once the lease expires", () => {
    const db = tempDb();
    expect(claim(db, ["acquire", "ticket:LLE-2", "--holder", "a", "--ttl", "10m", "--note", "PR #1"], T0).status).toBe(0);
    const held = claim(db, ["acquire", "ticket:LLE-2", "--holder", "b"], T0 + 9 * MIN);
    expect(held.status).toBe(3);
    expect(held.json.status).toBe("held");
    expect(held.json.claim).toMatchObject({ holder: "a", note: "PR #1", acquired_at: new Date(T0).toISOString() });
    expect(held.json.claim.expires_at).toBe(new Date(T0 + 10 * MIN).toISOString());

    expect(claim(db, ["show", "ticket:LLE-2"], T0 + 10 * MIN).json.status).toBe("free");
    const taken = claim(db, ["acquire", "ticket:LLE-2", "--holder", "b"], T0 + 10 * MIN + 1);
    expect(taken.status).toBe(0);
    expect(taken.json.claim.holder).toBe("b");
    expect(history(db).at(-1)).toMatchObject({ action: "takeover-expired", holder: "b", previous_holder: "a" });
  });

  it("only lets the holder renew or release", () => {
    const db = tempDb();
    claim(db, ["acquire", "pr:lleverage-ai/lleverage#8104", "--holder", "a"], T0);
    const renewByOther = claim(db, ["renew", "pr:lleverage-ai/lleverage#8104", "--holder", "b"], T0 + MIN);
    expect(renewByOther.status).toBe(3);
    const releaseByOther = claim(db, ["release", "pr:lleverage-ai/lleverage#8104", "--holder", "b"], T0 + MIN);
    expect(releaseByOther.status).toBe(3);
    const shown = claim(db, ["show", "pr:lleverage-ai/lleverage#8104"], T0 + MIN);
    expect(shown.json.claim).toMatchObject({ holder: "a", expires_at: new Date(T0 + 15 * MIN).toISOString() });

    const renewed = claim(db, ["renew", "pr:lleverage-ai/lleverage#8104", "--holder", "a", "--ttl", "30m"], T0 + 2 * MIN);
    expect(renewed.status).toBe(0);
    expect(renewed.json.claim.expires_at).toBe(new Date(T0 + 32 * MIN).toISOString());
    expect(claim(db, ["release", "pr:lleverage-ai/lleverage#8104", "--holder", "a"], T0 + 3 * MIN).status).toBe(0);
    expect(claim(db, ["show", "pr:lleverage-ai/lleverage#8104"], T0 + 3 * MIN).json.status).toBe("free");
    expect(claim(db, ["release", "pr:lleverage-ai/lleverage#8104", "--holder", "a"], T0 + 3 * MIN).status).toBe(0);
  });

  it("records steals with a reason and the previous holder", () => {
    const db = tempDb();
    claim(db, ["acquire", "ticket:LLE-3", "--holder", "a"], T0);
    expect(claim(db, ["steal", "ticket:LLE-3", "--holder", "tom"], T0).status).toBe(2);
    const stolen = claim(db, ["steal", "ticket:LLE-3", "--holder", "tom", "--reason", "session crashed"], T0 + MIN);
    expect(stolen.status).toBe(0);
    expect(stolen.json.previous.holder).toBe("a");
    expect(stolen.json.claim.holder).toBe("tom");
    expect(history(db).at(-1)).toMatchObject({ action: "steal", previous_holder: "a", reason: "session crashed" });
  });

  it("releases everything a holder has with release-all", () => {
    const db = tempDb();
    claim(db, ["acquire", "ticket:LLE-4", "--holder", "a"], T0);
    claim(db, ["acquire", "ticket:LLE-5", "--holder", "a"], T0);
    claim(db, ["acquire", "ticket:LLE-6", "--holder", "b"], T0);
    const released = claim(db, ["release-all", "--holder", "a"], T0);
    expect(released.status).toBe(0);
    expect(released.json.keys).toEqual(["ticket:LLE-4", "ticket:LLE-5"]);
    expect(claim(db, ["list"], T0).json.claims.map((c: any) => c.key)).toEqual(["ticket:LLE-6"]);
  });

  it("lists claims with no renewal for over half their lease as stale", () => {
    const db = tempDb();
    claim(db, ["acquire", "ticket:LLE-7", "--holder", "a", "--ttl", "10m"], T0);
    claim(db, ["acquire", "ticket:LLE-8", "--holder", "b", "--ttl", "1h"], T0);
    expect(claim(db, ["list", "--stale"], T0 + 4 * MIN).json.claims).toEqual([]);
    const stale = claim(db, ["list", "--stale"], T0 + 6 * MIN).json.claims;
    expect(stale.map((c: any) => c.key)).toEqual(["ticket:LLE-7"]);
    expect(claim(db, ["list", "--stale"], T0 + 11 * MIN).json.claims.map((c: any) => c.expired)).toEqual([true]);
    expect(claim(db, ["list"], T0 + 11 * MIN).json.claims.map((c: any) => c.key)).toEqual(["ticket:LLE-8"]);
  });

  it("normalises keys and caps the lease", () => {
    const db = tempDb();
    const result = claim(db, ["acquire", "Ticket:lle-9", "--holder", "a", "--ttl", "5h"], T0);
    expect(result.json.key).toBe("ticket:LLE-9");
    expect(result.json.claim.ttl_seconds).toBe(7200);
    expect(result.stderr).toContain("capped at 2h");
    expect(claim(db, ["show", "MAIN:Lleverage-AI/Lleverage"]).json.key).toBe("main:lleverage-ai/lleverage");
    expect(claim(db, ["acquire", "LLE-9", "--holder", "a"]).status).toBe(2);
    expect(claim(db, ["acquire", "ticket:LLE-9"]).status).toBe(2);
  });

  it("fails open with a warning when the store cannot be opened", () => {
    const dir = mkdtempSync(join(tmpdir(), "claims-test-"));
    tempDirs.push(dir);
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "");
    const result = claim(join(blocker, "claims.db"), ["acquire", "ticket:LLE-10", "--holder", "a"]);
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBe(3);
    expect(result.stderr).toContain("proceed without a lock");
    expect(result.json).toMatchObject({ ok: false, fail_open: true });
  });

  it("is wired into the ticket, readiness, workstream and sweep skills", () => {
    const read = (file: string) => readFileSync(join(root, file), "utf8");
    expect(read("skills/general/start-ticket/SKILL.md")).toContain("claim acquire ticket:TEAM-123");
    expect(read("skills/general/start-ticket/SKILL.md")).toContain("gh pr list --repo OWNER/REPO --state open --search TEAM-123");
    expect(read("skills/general/yolo-ticket/SKILL.md")).toContain("until the PR merges");
    expect(read("skills/general/_shared/pr-readiness/PROTOCOL.md")).toContain("claim acquire main:OWNER/REPO");
    expect(read("skills/lleverage/workstream/references/merge-and-review.md")).toContain("main:lleverage-ai/lleverage");
    expect(read("skills/lleverage/workstream/SKILL.md")).toContain("claim acquire ticket:ROOT");
    expect(read("skills/lleverage/sweep/SKILL.md")).toContain("claim list --stale");
  });

  it("runs through the PATH wrapper", () => {
    const db = tempDb();
    const result = spawnSync(wrapper, ["acquire", "ticket:LLE-11", "--holder", "a"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_CLAIMS_DB: db },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("acquired: ticket:LLE-11");
    expect(readFileSync(wrapper, "utf8").startsWith("#!/usr/bin/env bash")).toBe(true);
  });
});
