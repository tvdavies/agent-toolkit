import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

const ROOT = resolve(import.meta.dir, "..", "..");

function frontmatter(file: string): Record<string, unknown> {
	const source = readFileSync(file, "utf8");
	expect(source.startsWith("---\n")).toBe(true);
	const end = source.indexOf("\n---", 4);
	expect(end).toBeGreaterThan(3);
	return YAML.parse(source.slice(4, end)) as Record<string, unknown>;
}

describe("code-writer packaging", () => {
	it("declares the agents directory through the native pi-subagents package manifest key", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		expect(pkg["pi-subagents"]).toEqual({ agents: ["./agents"] });
		expect(pkg.pi).toEqual({ extensions: ["./extensions"] });
		expect(pkg.dependencies["pi-subagents"]).toBe("^0.28.0");
		expect(existsSync(join(ROOT, "agents", "code-writer.md"))).toBe(true);
	});

	it("packages a fresh, async, advertised writer with read/search/edit tools only", () => {
		const meta = frontmatter(join(ROOT, "agents", "code-writer.md"));
		expect(meta.name).toBe("code-writer");
		expect(meta.advertise).toBe(true);
		expect(meta.async).toBe(true);
		expect(meta.defaultContext).toBe("fresh");
		expect(meta.fast).toBe(false);
		expect(meta.inheritProjectContext).toBe(true);
		expect(meta.inheritGlobalContext).toBe(false);
		expect(meta.inheritSkills).toBe(false);
		expect(meta.allowNestedSubagents).toBe(false);
		expect(meta.acceptanceRole).toBe("writer");
		expect((meta.acceptance as { level: string }).level).toBe("none");
		const tools = String(meta.tools).split(",").map((tool) => tool.trim());
		expect(tools).toEqual(["read", "grep", "find", "ls", "edit", "write", "contact_supervisor"]);
		for (const forbidden of ["bash", "interactive_shell", "subagent", "workflow_run", "handoff_sessions"]) expect(tools).not.toContain(forbidden);
		// The model is deployment configuration, not role prose; extensions stay explicitly empty until configured.
		expect(meta.model).toBeUndefined();
		expect(meta.fallbackModels).toBeUndefined();
		expect(meta.extensions ?? null).toBeNull();
		expect(String(meta.description)).toContain("/code-writer models");
		expect(String(meta.description)).toContain("unverified");
	});

	it("keeps the role prose free of shell escape hatches and delivery claims", () => {
		const body = readFileSync(join(ROOT, "agents", "code-writer.md"), "utf8");
		expect(body).toContain("no shell");
		expect(body).toContain("Do not create executable wrappers, scripts or queued instructions");
		expect(body).toContain("tests were not run here");
		expect(body).toContain("A patch is not a verified delivery");
		expect(body).not.toMatch(/\bpi -p\b|claude -p|codex exec/);
	});
});
