import { describe, expect, it } from "bun:test";
import type { Decision } from "./decisions";
import { summarizeDecisions } from "./digest";

const NOW = Date.parse("2026-06-24T12:00:00Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

const decisions: Decision[] = [
	{ ts: at(10), kind: "trigger", summary: "slack: ship it" },
	{ ts: at(20), kind: "trigger", summary: "cron: heartbeat" },
	{ ts: at(30), kind: "guardrail-block", summary: "Blocked rm-rf-root" },
	{ ts: at(40), kind: "escalate", summary: "PR 4811 failing CI" },
	{ ts: at(60 * 30), kind: "trigger", summary: "old, outside 24h window? no" },
];

describe("summarizeDecisions", () => {
	it("counts by kind and lists escalations", () => {
		const out = summarizeDecisions(decisions, { now: NOW });
		expect(out).toContain("decisions");
		expect(out).toContain("trigger");
		expect(out).toContain("Escalations:");
		expect(out).toContain("PR 4811 failing CI");
		expect(out).toContain("Guardrail blocks: 1");
	});

	it("respects the window", () => {
		const out = summarizeDecisions(decisions, { now: NOW, sinceMs: 60_000 * 35 });
		// Within 35 minutes: the two triggers + the block; the 40m-ago escalation
		// and the 30h-ago trigger are excluded.
		expect(out).toContain("3 decisions");
		expect(out).not.toContain("PR 4811 failing CI");
	});

	it("reports an empty window", () => {
		expect(summarizeDecisions([], { now: NOW })).toContain("nothing recorded");
	});
});
