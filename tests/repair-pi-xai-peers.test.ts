import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../scripts/lib/repair-pi-xai-peers.mjs");
let directory: string;
let manifestPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-xai-peers-"));
  manifestPath = join(directory, "npm/node_modules/pi-xai/package.json");
  await mkdir(dirname(manifestPath), { recursive: true });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function repair() {
  return Bun.spawnSync(["node", script], {
    env: { ...process.env, PI_CODING_AGENT_DIR: directory }, stdout: "pipe", stderr: "pipe",
  });
}

test("moves host dependencies to wildcard peers and preserves unrelated metadata", async () => {
  const original = {
    name: "pi-xai", version: "0.18.0", pi: { extensions: ["./index.ts"] },
    dependencies: { typebox: "^1.3.6", unrelated: "^1.0.0" },
    peerDependencies: { "@earendil-works/pi-ai": ">=0.80.0", "@earendil-works/pi-coding-agent": ">=0.80.0", other: "^2" },
    devDependencies: { typebox: "^1.3.6" },
  };
  await writeFile(manifestPath, JSON.stringify(original));
  const result = repair();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({
    ...original, dependencies: { unrelated: "^1.0.0" },
    peerDependencies: { "@earendil-works/pi-ai": "*", "@earendil-works/pi-coding-agent": "*", typebox: "*", other: "^2" },
  });
  const fixed = await readFile(manifestPath, "utf8");
  expect(repair().stdout.toString()).toBe("");
  expect(await readFile(manifestPath, "utf8")).toBe(fixed);
});

test("removes an emptied dependencies section", async () => {
  await writeFile(manifestPath, JSON.stringify({ name: "pi-xai", dependencies: { typebox: "^1.3.6" } }));
  expect(repair().exitCode).toBe(0);
  expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({ name: "pi-xai", peerDependencies: { typebox: "*" } });
});

test("absent or already-correct package needs no repair", async () => {
  expect(repair().exitCode).toBe(0);
  const fixed = '{"name":"pi-xai","peerDependencies":{"typebox":"*"}}\n';
  await writeFile(manifestPath, fixed);
  expect(repair().exitCode).toBe(0);
  expect(await readFile(manifestPath, "utf8")).toBe(fixed);
});

test("fails without overwriting malformed or unexpected manifests", async () => {
  for (const source of ["invalid json", '{"name":"another-package"}']) {
    await writeFile(manifestPath, source);
    expect(repair().exitCode).not.toBe(0);
    expect(await readFile(manifestPath, "utf8")).toBe(source);
  }
});
