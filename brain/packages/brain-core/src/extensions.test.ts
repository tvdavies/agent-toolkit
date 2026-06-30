import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  createBrain,
  discoverExtensions,
  loadExtensions,
  trustExtension,
  validateExtensions,
} from "./index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempBrain(): Promise<{ homeDir: string; rootDir: string }> {
  const dir = await mkdtemp(resolve(tmpdir(), "brain-ext-"));
  tempDirs.push(dir);
  return { homeDir: resolve(dir, "home"), rootDir: resolve(dir, "root") };
}

test("discovers top-level and directory extensions", async () => {
  const { homeDir, rootDir } = await tempBrain();
  await mkdir(resolve(homeDir, "extensions", "pkg"), { recursive: true });
  await mkdir(resolve(rootDir, ".brain", "extensions"), { recursive: true });
  await writeFile(resolve(homeDir, "extensions", "a.ts"), "export default {}", "utf8");
  await writeFile(resolve(homeDir, "extensions", "pkg", "index.ts"), "export default {}", "utf8");
  await writeFile(resolve(rootDir, ".brain", "extensions", "b.ts"), "export default {}", "utf8");

  const found = await discoverExtensions({ homeDir, rootDir });

  expect(found.map((entry) => entry.scope).sort()).toEqual(["global", "global", "project"]);
  expect(found.map((entry) => entry.origin).sort()).toEqual([
    "directory",
    "top-level",
    "top-level",
  ]);
  expect(found.filter((entry) => entry.scope === "global").every((entry) => entry.trusted)).toBe(
    true,
  );
  expect(found.filter((entry) => entry.scope === "project").every((entry) => !entry.trusted)).toBe(
    true,
  );
});

test("project extensions require trust before loading", async () => {
  const { homeDir, rootDir } = await tempBrain();
  const extPath = resolve(rootDir, ".brain", "extensions", "local.ts");
  await mkdir(resolve(rootDir, ".brain", "extensions"), { recursive: true });
  await writeFile(
    extPath,
    `export default { name: "test/local", version: "1.0.0", setup() {} };`,
    "utf8",
  );

  await expect(loadExtensions({ homeDir, rootDir })).rejects.toThrow("untrusted project extension");

  await trustExtension({ homeDir, rootDir }, extPath);
  const loaded = await loadExtensions({ homeDir, rootDir });

  expect(loaded[0]?.module.name).toBe("test/local");
});

test("validation reports module metadata and shape errors", async () => {
  const { homeDir, rootDir } = await tempBrain();
  await mkdir(resolve(homeDir, "extensions"), { recursive: true });
  await writeFile(
    resolve(homeDir, "extensions", "ok.ts"),
    `export default { name: "test/ok", version: "1.0.0", capabilities: ["read-index"], setup() {} };`,
    "utf8",
  );
  await writeFile(
    resolve(homeDir, "extensions", "bad.ts"),
    `export default { name: "bad" };`,
    "utf8",
  );

  const results = await validateExtensions({ homeDir, rootDir });

  const ok = results.find((result) => result.path.endsWith("ok.ts"));
  const bad = results.find((result) => result.path.endsWith("bad.ts"));
  expect(ok).toMatchObject({
    ok: true,
    name: "test/ok",
    version: "1.0.0",
    capabilities: ["read-index"],
  });
  expect(bad?.ok).toBe(false);
  expect(bad?.error).toContain("default-export a BrainModule");
});

test("reload calls teardown and installs replacement module", async () => {
  let tornDown = 0;
  const first = {
    name: "test/first",
    version: "1.0.0",
    setup() {},
    teardown() {
      tornDown++;
    },
  };
  const second = { name: "test/second", version: "1.0.0", setup() {} };
  const brain = await createBrain({ modules: [first] });

  await brain.reload([second]);

  expect(tornDown).toBe(1);
  expect(brain.registry.commands.size).toBe(0);
  await brain.shutdown();
});

test("loads extension writers into runtime registry", async () => {
  const { homeDir, rootDir } = await tempBrain();
  await mkdir(resolve(homeDir, "extensions"), { recursive: true });
  await writeFile(
    resolve(homeDir, "extensions", "writer.ts"),
    `export default {
      name: "test/writer-module",
      version: "1.0.0",
      setup(brain) {
        brain.registerWriter({ id: "test/writer", write() { return []; } });
      }
    };`,
    "utf8",
  );

  const loaded = await loadExtensions({ homeDir, rootDir });
  const brain = await createBrain({ modules: loaded.map((entry) => entry.module) });

  expect(brain.registry.writers.map((entry) => entry.item.id)).toEqual(["test/writer"]);
  await brain.shutdown();
});
