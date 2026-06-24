/**
 * Digest — a deterministic, no-LLM summary of the decision spine over a window.
 *
 * The low-attention "what did my agent do" channel: counts by kind, the
 * escalations, and a few recent notable actions. Pure so it is tested directly;
 * the toolkit-digest CLI feeds it the decisions and routes the result to the
 * notify channel.
 */

import type { Decision } from "./decisions.ts";

const DAY_MS = 86_400_000;

export type DigestOptions = {
	/** Window length to summarise, ms (default 24h). */
	sinceMs?: number;
	now?: number;
};

function clock(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "??:??" : d.toISOString().slice(11, 16);
}

/** Build a compact markdown digest of decisions within the window. */
export function summarizeDecisions(decisions: Decision[], options: DigestOptions = {}): string {
	const now = options.now ?? Date.now();
	const since = now - (options.sinceMs ?? DAY_MS);
	const inWindow = decisions.filter((d) => {
		const t = Date.parse(d.ts);
		return Number.isFinite(t) && t >= since;
	});

	if (inWindow.length === 0) {
		return "Agent digest: nothing recorded in the window.";
	}

	const counts = new Map<string, number>();
	for (const d of inWindow) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
	const breakdown = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([kind, n]) => `${n} ${kind}`)
		.join(", ");

	const hours = Math.round((options.sinceMs ?? DAY_MS) / 3_600_000);
	const lines = [`Agent digest (last ${hours}h): ${inWindow.length} decisions — ${breakdown}.`];

	const escalations = inWindow.filter((d) => d.kind === "escalate");
	if (escalations.length > 0) {
		lines.push("", "Escalations:");
		for (const e of escalations.slice(-10)) lines.push(`- ${clock(e.ts)} ${e.summary}`);
	}

	const blocks = inWindow.filter((d) => d.kind === "guardrail-block");
	if (blocks.length > 0) lines.push("", `Guardrail blocks: ${blocks.length}.`);

	return lines.join("\n");
}
