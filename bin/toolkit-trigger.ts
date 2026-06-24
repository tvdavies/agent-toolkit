#!/usr/bin/env -S node --experimental-transform-types --no-warnings
/**
 * toolkit-trigger — append a trigger to the daemon's inbox.
 *
 * This is the single chokepoint anything (a cron line, a script, you) uses to
 * ask the resident agent to do work. It appends to inbox.jsonl (the reliable
 * transport the daemon drains) and, when a TADU workspace is present, also
 * creates a TADU task so the work is visible in the spine (best-effort).
 *
 * Usage:
 *   toolkit-trigger [--source <s>] [--dedupe <key>] [--no-tadu] <text...>
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FileInbox } from "../daemon/inbox.ts";
import { CronJobStore } from "../extensions/cron/jobs.ts";
import {
	type GateVerdict,
	type HeartbeatGateState,
	parseHoursWindow,
	shouldRunHeartbeat,
} from "../extensions/heartbeat/schedule-gate.ts";
import { stateDir } from "../extensions/lib/decisions.ts";

type Args = {
	source?: string;
	dedupeKey?: string;
	noTadu: boolean;
	cronJob?: string;
	text: string;
};

function parseArgs(argv: string[]): Args {
	const out: Args = { noTadu: false, text: "" };
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--source") out.source = argv[++i];
		else if (arg === "--dedupe") out.dedupeKey = argv[++i];
		else if (arg === "--cron-job") out.cronJob = argv[++i];
		else if (arg === "--no-tadu") out.noTadu = true;
		else if (arg) rest.push(arg);
	}
	out.text = rest.join(" ").trim();
	return out;
}

function findTaduWorkspace(start: string): boolean {
	let dir = start;
	for (let i = 0; i < 30; i += 1) {
		if (existsSync(join(dir, ".tadu"))) return true;
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return false;
}

/** Best-effort: create a TADU task for visibility; return its id if created. */
function createTaduTask(text: string): string | undefined {
	try {
		const title = text.length > 80 ? `${text.slice(0, 79)}…` : text;
		const result = spawnSync("tadu", ["new", "--title", title, "--label", "trigger"], {
			encoding: "utf8",
			timeout: 5000,
		});
		if (result.status !== 0) return undefined;
		const id = result.stdout.trim().split(/\s+/)[0];
		return id || undefined;
	} catch {
		return undefined;
	}
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Minimum minutes between heartbeats. Explicit env wins; otherwise default to
 * hourly when the daemon detected an Anthropic/Claude model (mirrors OpenClaw's
 * subscription back-off), else 30 minutes.
 */
function heartbeatMinIntervalMin(): number {
	const env = Number(process.env.AGENT_TOOLKIT_HEARTBEAT_MIN_MINUTES);
	if (Number.isFinite(env) && env >= 0) return Math.floor(env); // 0 disables gating
	const authMode = (readJson(join(stateDir(), "agent-state.json")) as { authMode?: string } | null)?.authMode;
	return authMode === "anthropic" ? 60 : 30;
}

/** Gate a heartbeat: enforce the min interval + optional active-hours window. */
function heartbeatGate(): GateVerdict {
	const state = (readJson(join(stateDir(), "heartbeat-gate.json")) as HeartbeatGateState | null) ?? {
		lastRunMs: 0,
	};
	return shouldRunHeartbeat(
		state,
		{
			minIntervalMin: heartbeatMinIntervalMin(),
			activeHours: parseHoursWindow(process.env.AGENT_TOOLKIT_HEARTBEAT_HOURS),
		},
		new Date(),
	);
}

function recordHeartbeatRun(now: number): void {
	const path = join(stateDir(), "heartbeat-gate.json");
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ lastRunMs: now }), "utf8");
	} catch {
		// best-effort
	}
}

/** Resolve a cron job's prompt from the store and queue it (no TADU task). */
function runCronJob(id: string): void {
	const store = new CronJobStore();
	let job = store.get(id);
	if (!job) {
		store.seedDefaults();
		job = store.get(id);
	}
	if (!job) {
		console.error(`unknown cron job: ${id}`);
		process.exit(1);
	}
	// The heartbeat enforces its own effective cadence regardless of the timer.
	if (id === "heartbeat") {
		const verdict = heartbeatGate();
		if (!verdict.run) {
			console.log(`heartbeat skipped (${verdict.reason})`);
			return;
		}
	}
	const inbox = new FileInbox(join(stateDir(), "inbox.jsonl"));
	const trigger = inbox.append({ text: job.text, source: job.source ?? `cron:${id}` });
	if (id === "heartbeat") recordHeartbeatRun(Date.now());
	console.log(`queued cron job ${id} as trigger ${trigger.id}`);
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	if (args.cronJob) {
		runCronJob(args.cronJob);
		return;
	}
	if (args.text === "") {
		console.error(
			"Usage: toolkit-trigger [--source <s>] [--dedupe <key>] [--no-tadu] <text...>\n       toolkit-trigger --cron-job <id>",
		);
		process.exit(1);
	}

	const taduTask =
		!args.noTadu && findTaduWorkspace(process.cwd()) ? createTaduTask(args.text) : undefined;

	const inbox = new FileInbox(join(stateDir(), "inbox.jsonl"));
	const trigger = inbox.append({
		text: args.text,
		source: args.source ?? "cli",
		dedupeKey: args.dedupeKey,
		taduTask,
	});

	console.log(
		`queued trigger ${trigger.id}${taduTask ? ` (tadu ${taduTask})` : ""}: ${args.text.slice(0, 80)}`,
	);
}

main();
