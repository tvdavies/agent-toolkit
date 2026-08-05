import { describe, expect, it } from "bun:test";
import { buildDrivePrPrompt, DRIVE_PR_MARKER, isDrivePrPrompt, parseDrivePrNumber } from "./drive-pr";

describe("drive-pr protocol", () => {
	it("recognises and parses a drive-pr prompt", () => {
		const p = buildDrivePrPrompt(4988, { repo: "/repos/x", readinessDir: "/shared/pr-readiness" });
		expect(p.startsWith(DRIVE_PR_MARKER)).toBe(true);
		expect(isDrivePrPrompt(p)).toBe(true);
		expect(isDrivePrPrompt("do something else")).toBe(false);
		expect(parseDrivePrNumber(p)).toBe(4988);
		expect(parseDrivePrNumber("not a drive-pr")).toBeUndefined();
	});

	it("delegates blocker semantics to the shared protocol", () => {
		const p = buildDrivePrPrompt(123, { repo: "/home/me/proj", readinessDir: "/opt/readiness" });
		expect(p).toContain("#123");
		expect(p).toContain("/home/me/proj");
		expect(p).toContain("/opt/readiness/PROTOCOL.md");
		expect(p).toContain("/opt/readiness/scripts/fetch-pr-blockers.sh");
		expect(p).toContain("/opt/readiness/scripts/reply-and-resolve.sh");
		expect(p).toContain("It is authoritative");
	});

	it("adds only worktree and park-resume control policy", () => {
		const p = buildDrivePrPrompt(5, { repo: "/r", readinessDir: "/readiness" });
		expect(p).toContain("worktree_adopt");
		expect(p).toContain('cd "<WT>"');
		expect(p).toContain("park");
		expect(p).toContain("READY TO MERGE");
		expect(p).toContain("no-progress");
	});

	it("forbids merge, force-push, and pushing to a protected branch", () => {
		const p = buildDrivePrPrompt(9, { repo: "/r", readinessDir: "/readiness" });
		expect(p).toContain("Never merge");
		expect(p).toContain("Never force-push");
		expect(p).toContain("protected/base branch");
	});
});
