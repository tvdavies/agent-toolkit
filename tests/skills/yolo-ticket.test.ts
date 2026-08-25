import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

const root = resolve(import.meta.dir, "../..");
const skillPath = join(root, "skills/general/yolo-ticket/SKILL.md");
const openAiPath = join(root, "skills/general/yolo-ticket/agents/openai.yaml");

function source() {
  return readFileSync(skillPath, "utf8");
}

describe("yolo-ticket skill", () => {
  it("is explicit-only and requires exactly one Linear ticket", () => {
    const skill = source();
    const end = skill.indexOf("\n---\n", 4);
    const frontmatter = YAML.parse(skill.slice(4, end));
    const openAi = readFileSync(openAiPath, "utf8");

    expect(frontmatter.name).toBe("yolo-ticket");
    expect(frontmatter["disable-model-invocation"]).toBe(true);
    expect(frontmatter.description.length).toBeLessThan(1024);
    expect(frontmatter.description).toContain("explicit");
    expect(frontmatter.description).toContain("yolo-ticket");
    expect(frontmatter.description).toContain("yolo this ticket");
    expect(openAi).toContain("allow_implicit_invocation: false");
    expect(skill).toContain("Require exactly one identifier");
    expect(skill).toContain("^[A-Z][A-Z0-9]*-[0-9]+$");
    expect(skill).toContain("reject flags");
    expect(skill).toContain("multiple tickets");
  });

  it("composes start-ticket and babysit-pr in the same worktree", () => {
    const skill = source();

    expect(skill).toContain("$SKILL_DIR/../start-ticket/SKILL.md");
    expect(skill).toContain("PR READY FOR REVIEW");
    expect(skill).toContain("$SKILL_DIR/../babysit-pr/SKILL.md");
    expect(skill).toContain("Reuse the same dedicated worktree, branch, and PR");
    expect(skill).toContain("Keep the original ticket worktree as the only writer");
    expect(skill).toContain("push-before-resolve");
  });

  it("selects one allowed merge method and enables only normal auto-merge", () => {
    const skill = source();

    expect(skill).toContain("gh api repos/OWNER/REPO");
    expect(skill).toContain("allow_squash_merge");
    expect(skill).toContain("allow_rebase_merge");
    expect(skill).toContain("allow_merge_commit");
    expect(skill).toContain("**squash**, then **rebase**");
    expect(skill).toContain("then **merge commit**");
    expect(skill).toContain("`--squash`, `--rebase`, or `--merge`");
    expect(skill).toContain("gh pr merge PR_NUMBER --repo OWNER/REPO --auto METHOD_FLAG");
    expect(skill).toContain('--match-head-commit "$READY_HEAD"');
    expect(skill).toContain("repository protections or merge-queue");
    expect(skill).toContain("use exactly one selected");
    expect(skill).toContain("Never pass more than one method flag");
    expect(skill).not.toMatch(/gh pr merge[^\n]*--admin/);
    expect(skill).not.toMatch(/gh pr merge[^\n]*--force/);
    expect(skill).toContain("do not retry without `--auto`");
    expect(skill).toContain("Never fall back to an immediate/manual merge");
    expect(skill).toContain("Never use a direct merge fallback");
    expect(skill).toContain("Do not enable auto-merge until `babysit-pr` proves `READY TO MERGE`");
    expect(skill).toContain("gh pr merge PR_NUMBER --repo OWNER/REPO --disable-auto");
    expect(skill).toContain("If the readback head differs from");
    expect(skill).toContain("stderr/API response, and classified cause");
    expect(skill).toContain("Never approve your own PR");
    expect(skill).toContain("dismiss reviews");
    expect(skill).toContain("change branch protection");
  });

  it("babysits before enabling auto-merge, then watches until a terminal outcome", () => {
    const skill = source();
    const babysitPhase = skill.indexOf("## Phase 3: Babysit to verified readiness");
    const autoMergePhase = skill.indexOf("## Phase 4: Enable auto-merge at the ready head");

    expect(babysitPhase).toBeGreaterThan(0);
    expect(autoMergePhase).toBeGreaterThan(babysitPhase);
    expect(skill.indexOf("gh pr merge PR_NUMBER --repo OWNER/REPO --auto METHOD_FLAG")).toBeGreaterThan(autoMergePhase);
    expect(skill).toContain("`READY TO MERGE` from `babysit-pr` is an intermediate checkpoint");
    expect(skill).toContain("every shared readiness criterion");
    expect(skill).toContain("autoMergeRequest");
    expect(skill).toContain("re-fetch authoritative PR state with `gh pr view`");
    expect(skill).toContain("wait-for-pr-change.sh\" snapshot");
    expect(skill).toContain("TEMP_BASELINE");
    expect(skill).toContain('mv "$TEMP_BASELINE" "$BASELINE"');
    expect(skill).toContain("wait-for-pr-change.sh\" wait");
    expect(skill).toContain("## Phase 5: Watch auto-merge to completion");
    expect(skill).toContain("After roughly three cycles");
    expect(skill).toContain("MERGED");
    expect(skill).toContain("BLOCKED");
    expect(skill).toContain("CLOSED UNMERGED");
    expect(skill).toContain("INTERRUPTED");
    expect(skill).toContain("Never finish yolo-ticket merely because the PR is `READY TO MERGE`");
  });
});
