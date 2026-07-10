import { describe, expect, it } from "bun:test";
import { ago, formatStatus, type StatusModel } from "./status";

const NOW = Date.parse("2026-06-24T12:00:00Z");

function model(overrides: Partial<StatusModel> = {}): StatusModel {
	return {
		scheduler: { pending: 0, jobs: [] },
		workflows: [],
		brain: { initialised: false, concepts: 0 },
		decisions: [],
		...overrides,
	};
}

describe("ago", () => {
	it("renders relative times", () => {
		expect(ago("2026-06-24T11:59:30Z", NOW)).toBe("30s ago");
		expect(ago("2026-06-24T11:30:00Z", NOW)).toBe("30m ago");
		expect(ago("2026-06-24T09:00:00Z", NOW)).toBe("3h ago");
		expect(ago("2026-06-21T12:00:00Z", NOW)).toBe("3d ago");
		expect(ago(undefined, NOW)).toBe("never");
	});
});

describe("formatStatus", () => {
	it("shows sensible defaults for an empty system", () => {
		const out = formatStatus(model(), NOW);
		expect(out).toContain("Daemon:    not running");
		expect(out).toContain("Schedule:  0 pending");
		expect(out).toContain("Brain:     not initialised");
		expect(out).toContain("TADU:      no workspace");
		expect(out).toContain("(none yet)");
	});

	it("summarises a busy system", () => {
		const out = formatStatus(
			model({
				daemon: { running: true, uptime: "2h", restarts: 1, lastTrigger: "2026-06-24T11:55:00Z" },
				scheduler: { pending: 1, jobs: [{ preview: "in 10m: check PR" }] },
				workflows: [
					{ id: "wf_1", name: "deep-research", status: "running" },
					{ id: "wf_2", name: "audit", status: "done" },
				],
				brain: { initialised: true, concepts: 42 },
				tadu: { current: "TASK-0007", open: 5 },
				decisions: [
					{ ts: "2026-06-24T11:58:00Z", kind: "guardrail-block", summary: "Blocked rm-rf-root" },
				],
			}),
			NOW,
		);
		expect(out).toContain("Daemon:    running (up 2h, 1 restarts, last trigger 5m ago)");
		expect(out).toContain("Workflows: 1 running, 2 recent");
		expect(out).toContain("Brain:     42 concepts");
		expect(out).toContain("TADU:      current TASK-0007, 5 open");
		expect(out).toContain("guardrail-block");
	});

	it("truncates a long scheduler preview", () => {
		const out = formatStatus(model({ scheduler: { pending: 1, jobs: [{ preview: "x".repeat(200) }] } }), NOW);
		expect(out).toContain("…");
	});
});
