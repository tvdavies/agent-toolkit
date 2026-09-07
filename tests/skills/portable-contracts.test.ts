import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const skill = (name: string, group = "general") => read(`skills/${group}/${name}/SKILL.md`);

describe("portable skill contracts (static guards, not model behaviour claims)", () => {
  test("local draft/HTML, explicit publication, waiting and implementation remain separate", () => {
    for (const name of ["plan-work", "plan-review"]) {
      const text = skill(name, "personal");
      expect(text).toContain("publication authorization");
      expect(text).toContain("wait mode");
      expect(text).toContain("implementation authority");
      expect(text).toMatch(/HTML-only/);
      expect(text).toMatch(/return the\nrequested output and stop|returns the requested output and stops/);
      expect(text.replace(/\s+/g, " ")).toMatch(/explicit.*upload\/publication/i);
      expect(text).toMatch(/No default polling/i);
      expect(text).not.toContain("On `approved`, proceed with the work");
      expect(text).not.toContain("poll `status` every 30–60 s while waiting");
      expect(text).toContain("plan-ticket");
      expect(text).toContain("seeded");
      expect(text).toContain("plan_feedback");
      expect(text).toMatch(/current-\s*version approval/);
    }
  });

  test("plan service CLI documentation stays usable without forcing the route", () => {
    const text = skill("plan-review", "personal");
    for (const command of ["create", "revise", "status", "comments", "comment", "resolve", "markdown", "snapshot"]) {
      expect(text).toContain(`plan.sh ${command}`);
    }
    expect(text).toContain('bash "$SKILL_DIR/scripts/plan.sh"');
    expect(existsSync(path.join(root, "skills/personal/plan-review/scripts/plan.sh"))).toBe(true);
  });

  test("headless never grants publishing authority or silently drops required review", () => {
    const text = skill("pr-review");
    expect(text).toContain("It does not imply `--post`");
    expect(text).toContain("explicit caller publishing policy");
    expect(text).toContain("Never hide failed coverage");
    expect(text).toContain("Incomplete REQUIRED coverage");
    expect(text).toContain("`INCOMPLETE`");
    expect(text).toContain("independent read-only challenge");
    expect(text).toContain("one independent execution owner");
    for (const obsolete of ["tasks: [", "concurrency:", "clarify:", "tools: [", "claude -p", "Headless implies", "Silent degradation", "Do NOT run tests"]) {
      expect(text).not.toContain(obsolete);
    }
    expect(text).toContain("Do not guess tool parameters");
    expect(text).toMatch(/agent\s+CLI through shell/);
  });

  test("verification matrix distinguishes target, isolation, current-head CI and effects", () => {
    const text = skill("pr-review");
    for (const phrase of ["exact head with current-head CI", "missing/pending/failed/stale CI", "Local change, isolated checkout", "Shared/dirty/unrelated checkout", "Scripts\ncan install packages", "Run each agreed check once per patch revision"]) expect(text).toContain(phrase);
    for (const status of ["passed", "failed", "unavailable", "skipped"]) expect(text).toContain(`\`${status}\``);
    expect(text).not.toContain("These are read-only verification steps");
  });

  test("all full posting command examples bind the reviewed head and run directory", () => {
    const files = ["skills/general/pr-review/SKILL.md", "skills/general/pr-review/references/github-output.md"];
    for (const file of files) {
      const text = read(file);
      expect(text).not.toContain('${PR_REVIEW_TMPDIR:-${TMPDIR:-/tmp}}');
      for (const block of text.matchAll(/```bash\n([\s\S]*?)\n```/g)) {
        if (!block[1]!.includes("post-review.sh")) continue;
        expect(block[1]).toContain('--expected-head "$HEAD_OID"');
        expect(block[1]).toContain('"$REVIEW_TMPDIR/pr-review.md"');
        expect(block[1]).toContain('"$SKILL_DIR/scripts/post-review.sh"');
      }
    }
  });

  test("shared references resolve with each skill installed individually", () => {
    const files = ["skills/general/pr-review/SKILL.md", "skills/general/pr-review/references/github-output.md", "skills/general/pr-review/references/finding-format.md", "skills/general/improve/SKILL.md", "skills/general/skill-creator/SKILL.md"];
    for (const file of files) {
      for (const match of read(file).matchAll(/\]\(([^)]+\.md)\)/g)) {
        const target = match[1]!;
        if (target.includes(":")) continue;
        const resolved = path.resolve(root, path.dirname(file), target);
        const skillDirectory = path.join(root, file.split("/").slice(0, 3).join("/"));
        expect(resolved.startsWith(skillDirectory + path.sep)).toBe(true);
        expect(existsSync(resolved), `${file} -> ${target}`).toBe(true);
      }
    }
  });

  test("prose editing preserves literals; API lookup triggers on uncertainty, not framework mention", () => {
    const unslop = skill("unslop");
    expect(unslop).toContain("Apply only to editable prose");
    expect(unslop).toContain("quoted/source text");
    expect(unslop).toContain("schemas, structured output and required");
    expect(unslop).not.toContain("Must always apply");
    const context7 = skill("context7-mcp");
    expect(context7).toContain("A framework mention alone is not a trigger");
    expect(context7).toContain("current schemas");
    expect(context7).toContain("official, version-specific docs");
    expect(context7).toContain("Do not guess parameters");
  });

  test("high-impact skills check isolation and capabilities instead of fixed agents/paths", () => {
    expect(skill("worktrees")).not.toContain("you already start in your own auto-created worktree");
    expect(skill("worktrees")).toContain("One writer per checkout");
    const closing = read("skills/general/improve/references/closing-the-loop.md");
    expect(closing).not.toMatch(/sonnet|haiku|SendMessage|isolation: "worktree"/);
    expect(closing).toContain("Never invoke an");
    expect(closing).toContain("agent CLI via shell");
    const creator = skill("skill-creator");
    expect(creator).toContain("Discover active tool schemas");
    expect(creator).toContain("edit live global settings");
    expect(creator).toContain("Bundle references/scripts inside the skill");
  });
});
