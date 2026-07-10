/**
 * Observe — pure rendering of the toolkit status pane.
 *
 * The data-gathering (session entries, workflow-run manifests, the brain, TADU,
 * the decision spine) lives in ./index; this module turns the gathered model
 * into a single legible pane. Kept pure so the formatting is unit-tested.
 */

import type { Decision } from "../lib/decisions";

export type StatusModel = {
	daemon?: {
		running: boolean;
		uptime?: string;
		restarts?: number;
		lastTrigger?: string;
	};
	scheduler: { pending: number; jobs: { preview: string }[] };
	workflows: { id: string; name?: string; status: string }[];
	brain: { initialised: boolean; concepts: number };
	tadu?: { current?: string; open?: number };
	decisions: Decision[];
};

const MAX_LISTED = 5;

function truncate(text: string, max = 64): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Compact "Xs/Xm/Xh/Xd ago" for an ISO timestamp relative to `now` (epoch ms). */
export function ago(iso: string | undefined, now: number): string {
	if (!iso) return "never";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "?";
	const s = Math.max(0, Math.round((now - then) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

function clockOf(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? "--:--"
		: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Render the status model as a single pane of glass. `now` is injectable. */
export function formatStatus(model: StatusModel, now: number): string {
	const lines: string[] = ["Agent Toolkit — status", ""];

	if (!model.daemon || !model.daemon.running) {
		lines.push("Daemon:    not running");
	} else {
		const parts = [`up ${model.daemon.uptime ?? "?"}`];
		if (typeof model.daemon.restarts === "number") parts.push(`${model.daemon.restarts} restarts`);
		parts.push(`last trigger ${ago(model.daemon.lastTrigger, now)}`);
		lines.push(`Daemon:    running (${parts.join(", ")})`);
	}

	lines.push(`Schedule:  ${model.scheduler.pending} pending`);
	for (const job of model.scheduler.jobs.slice(0, MAX_LISTED)) {
		lines.push(`           • ${truncate(job.preview)}`);
	}

	const running = model.workflows.filter((w) => w.status === "running").length;
	lines.push(`Workflows: ${running} running, ${model.workflows.length} recent`);
	for (const wf of model.workflows.slice(0, MAX_LISTED)) {
		lines.push(`           • ${wf.status.padEnd(8)} ${wf.name ?? wf.id}`);
	}

	lines.push(
		model.brain.initialised
			? `Brain:     ${model.brain.concepts} concepts`
			: "Brain:     not initialised",
	);

	if (model.tadu) {
		const bits: string[] = [];
		if (model.tadu.current) bits.push(`current ${model.tadu.current}`);
		if (typeof model.tadu.open === "number") bits.push(`${model.tadu.open} open`);
		lines.push(`TADU:      ${bits.length ? bits.join(", ") : "no active task"}`);
	} else {
		lines.push("TADU:      no workspace");
	}

	lines.push("", `Decisions (last ${Math.min(MAX_LISTED, model.decisions.length)}):`);
	if (model.decisions.length === 0) {
		lines.push("           (none yet)");
	} else {
		for (const d of model.decisions.slice(-MAX_LISTED)) {
			lines.push(`           • ${clockOf(d.ts)} ${d.kind.padEnd(16)} ${truncate(d.summary, 56)}`);
		}
	}

	return lines.join("\n");
}
