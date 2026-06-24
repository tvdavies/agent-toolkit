import { describe, expect, it } from "bun:test";
import {
	type CronRenderContext,
	extractManagedBlock,
	MANAGED_BEGIN,
	MANAGED_END,
	parseJobIds,
	renderJobCommand,
	renderManagedBlock,
	replaceManagedBlock,
} from "./crontab";
import type { CronJob } from "./jobs";

const ctx: CronRenderContext = {
	runtime: "node --experimental-transform-types",
	triggerBin: "/repo/bin/toolkit-trigger.ts",
	envFile: "/home/tom/.config/agent-toolkit/serve.env",
	lockDir: "/tmp",
};

const heartbeat: CronJob = {
	id: "heartbeat",
	schedule: "*/30 * * * *",
	text: "[heartbeat] do the thing",
	description: "Heartbeat check",
};

describe("renderJobCommand", () => {
	it("wraps in flock and references the job id, not free text", () => {
		const cmd = renderJobCommand(heartbeat, ctx);
		expect(cmd).toContain("flock -n /tmp/agent-toolkit-cron-heartbeat.lock");
		expect(cmd).toContain(". /home/tom/.config/agent-toolkit/serve.env");
		expect(cmd).toContain("--cron-job heartbeat");
		// The prompt text must NOT appear on the cron line (it lives in the store).
		expect(cmd).not.toContain("do the thing");
	});
});

describe("renderManagedBlock", () => {
	it("emits markers, a per-job comment, and the schedule + command", () => {
		const block = renderManagedBlock([heartbeat], ctx);
		expect(block).toContain(MANAGED_BEGIN);
		expect(block).toContain(MANAGED_END);
		expect(block).toContain("# job:heartbeat — Heartbeat check");
		expect(block).toContain("*/30 * * * * flock -n");
	});
});

describe("replaceManagedBlock", () => {
	const block = renderManagedBlock([heartbeat], ctx);

	it("appends to a crontab that has no managed block, preserving other lines", () => {
		const existing = "0 9 * * * /usr/bin/backup.sh\n";
		const out = replaceManagedBlock(existing, block);
		expect(out).toContain("/usr/bin/backup.sh");
		expect(out).toContain(MANAGED_BEGIN);
		expect(out.endsWith("\n")).toBe(true);
	});

	it("replaces an existing managed block in place and is idempotent", () => {
		const existing = `0 9 * * * /usr/bin/backup.sh\n\n${block}\n`;
		const updated = renderManagedBlock(
			[{ ...heartbeat, schedule: "*/15 * * * *" }],
			ctx,
		);
		const out = replaceManagedBlock(existing, updated);
		expect(out).toContain("*/15 * * * * flock");
		expect(out).not.toContain("*/30 * * * * flock");
		expect(out).toContain("/usr/bin/backup.sh");
		// Splicing the same block twice yields the same result.
		expect(replaceManagedBlock(out, updated)).toBe(out);
	});

	it("removes the managed block when given an empty block", () => {
		const existing = `keep me\n\n${block}\n`;
		const out = replaceManagedBlock(existing, "");
		expect(out).toContain("keep me");
		expect(out).not.toContain(MANAGED_BEGIN);
	});
});

describe("extractManagedBlock / parseJobIds", () => {
	it("extracts the block and the job ids within it", () => {
		const jobs: CronJob[] = [
			heartbeat,
			{ id: "digest", schedule: "0 18 * * *", text: "[digest] summarise" },
		];
		const crontab = replaceManagedBlock("other\n", renderManagedBlock(jobs, ctx));
		expect(extractManagedBlock(crontab)).toContain("# job:heartbeat");
		expect(parseJobIds(crontab)).toEqual(["heartbeat", "digest"]);
	});

	it("returns empty when there is no managed block", () => {
		expect(extractManagedBlock("0 9 * * * x\n")).toBe("");
		expect(parseJobIds("0 9 * * * x\n")).toEqual([]);
	});
});
