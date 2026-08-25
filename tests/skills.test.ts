import { describe, expect, it } from "bun:test";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(import.meta.dir, "..");
const skillsRoot = path.join(root, "skills");
const groups = ["general", "personal", "lleverage"] as const;

async function skillDirectories(): Promise<string[]> {
  const result: string[] = [];
  for (const group of groups) {
    for (const entry of await readdir(path.join(skillsRoot, group), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "_shared") result.push(path.join(skillsRoot, group, entry.name));
    }
  }
  return result.sort();
}

function parseFrontmatter(source: string, file: string): Record<string, unknown> {
  expect(source.startsWith("---\n"), `${file} must start with YAML frontmatter`).toBe(true);
  const end = source.indexOf("\n---\n", 4);
  expect(end, `${file} must close YAML frontmatter`).toBeGreaterThan(3);
  return YAML.parse(source.slice(4, end)) as Record<string, unknown>;
}

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(item));
    else files.push(item);
  }
  return files;
}

function staleFlatSkillPaths(source: string, skillNames: ReadonlySet<string>): string[] {
  const stale: string[] = [];
  for (const match of source.matchAll(/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\//g)) {
    const name = match[1];
    if (!name || groups.includes(name as (typeof groups)[number]) || !skillNames.has(name)) continue;
    const prefix = source.slice(Math.max(0, (match.index ?? 0) - 16), match.index);
    if (/(?:\.agents|\.claude)\/$/.test(prefix)) continue;
    stale.push(match[0]);
  }
  return stale;
}

describe("grouped skills", () => {
  it("has valid, unique Agent Skills frontmatter", async () => {
    const names = new Map<string, string>();
    for (const directory of await skillDirectories()) {
      const file = path.join(directory, "SKILL.md");
      expect((await stat(file)).isFile(), `${file} must exist`).toBe(true);
      const frontmatter = parseFrontmatter(await readFile(file, "utf8"), file);
      const name = frontmatter.name;
      const description = frontmatter.description;
      expect(typeof name, `${file} name`).toBe("string");
      expect(name as string).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(name).toBe(path.basename(directory));
      expect(typeof description, `${file} description`).toBe("string");
      expect((description as string).trim().length, `${file} description`).toBeGreaterThan(10);
      expect(names.has(name as string), `duplicate skill name '${String(name)}'`).toBe(false);
      names.set(name as string, file);
    }
  });

  it("contains no nested duplicate SKILL.md files", async () => {
    for (const directory of await skillDirectories()) {
      const nested = (await walk(directory)).filter((file) => path.basename(file) === "SKILL.md");
      expect(nested, directory).toEqual([path.join(directory, "SKILL.md")]);
    }
  });

  it("contains no source-tree symlinks", async () => {
    const files = await walk(skillsRoot);
    for (const file of files) {
      expect(await realpath(file), `${file} must be vendored content`).toBe(file);
    }
  });

  it("contains no stale repository references to the old flat skill layout", async () => {
    const skillNames = new Set((await skillDirectories()).map((directory) => path.basename(directory)));
    expect(staleFlatSkillPaths("../skills/general/start-ticket/SKILL.md", skillNames)).toEqual([]);
    expect(staleFlatSkillPaths(`../${["skills", "start-ticket", "SKILL.md"].join("/")}`, skillNames)).toEqual([
      "skills/start-ticket/",
    ]);

    const sourceFiles = (
      await Promise.all(["extensions", "scripts", "tests"].map((directory) => walk(path.join(root, directory))))
    ).flat();
    const thisFile = fileURLToPath(import.meta.url);
    const checkedExtensions = new Set([".ts", ".js", ".mjs", ".sh", ".md", ".json", ".yaml", ".yml"]);
    const findings: string[] = [];
    for (const file of sourceFiles) {
      if (path.resolve(file) === thisFile || !checkedExtensions.has(path.extname(file))) continue;
      const stale = staleFlatSkillPaths(await readFile(file, "utf8"), skillNames);
      findings.push(...stale.map((reference) => `${path.relative(root, file)}: ${reference}`));
    }
    expect(findings).toEqual([]);
  });
});
