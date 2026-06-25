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
	resolveMinIntervalMinutes,
	shouldRunHeartbeat,
} from "../extensions/heartbeat/schedule-gate.ts";
import { stateDir } from "../extensions/lib/decisions.ts";
import { buildDrivePrPrompt } from "../extensions/lib/drive-pr.ts";
import { writeAnswer } from "../extensions/lib/park.ts";
import { taduRoot, workspaceExists } from "../extensions/lib/tadu.ts";

const repoDir = join(import.meta.dirname, "..");

type Args = {
	source?: string;
	dedupeKey?: string;
	noTadu: boolean;
	cronJob?: string;
	drivePr?: string;
	repo?: string;
	answerRef?: string;
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
		else if (arg === "--drive-pr") out.drivePr = argv[++i];
		else if (arg === "--repo") out.repo = argv[++i];
		else if (arg === "--answer") out.answerRef = argv[++i];
		else if (arg === "--no-tadu") out.noTadu = true;
		else if (arg) rest.push(arg);
	}
	out.text = rest.join(" ").trim();
	return out;
}

/** Best-effort: create a TADU task in the central workspace for visibility. */
function createTaduTask(text: string, source?: string): string | undefined {
	try {
		const title = text.length > 80 ? `${text.slice(0, 79)}…` : text;
		const labels = ["trigger", ...(source ? [`src:${source}`] : [])].flatMap((l) => ["--label", l]);
		const result = spawnSync("tadu", ["new", "--title", title, ...labels], {
			cwd: taduRoot(),
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

/** Minimum minutes between heartbeats (env override, else auth-aware default). */
function heartbeatMinIntervalMin(): number {
	const authMode = (readJson(join(stateDir(), "agent-state.json")) as { authMode?: string } | null)?.authMode;
	return resolveMinIntervalMinutes(process.env.AGENT_TOOLKIT_HEARTBEAT_MIN_MINUTES, authMode);
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
	// Answer a blocked worker's needs_human question: the daemon resumes that exact
	// session with this answer injected. ref = the task id (e.g. TASK-12) or run id.
	if (args.answerRef) {
		if (args.text === "") {
			console.error('Usage: toolkit-trigger --answer <task-id|run-id> "<your answer>"');
			process.exit(1);
		}
		writeAnswer(stateDir(), args.answerRef, args.text, new Date().toISOString());
		console.log(`answer recorded for ${args.answerRef}; the worker will resume shortly.`);
		return;
	}
	// Drive-to-green (Part B): dispatch an autonomous worker that loops a PR to
	// green via park/resume. Builds the process prompt; the rest flows as a normal
	// tracked worker task.
	if (args.drivePr) {
		const n = Number(args.drivePr);
		if (!Number.isInteger(n) || n <= 0) {
			console.error(`--drive-pr expects a positive PR number, got "${args.drivePr}"`);
			process.exit(1);
		}
		// Require an explicit local repo path: the worker isolates the PR branch
		// there. Without it the worker would resolve its own (agent-toolkit) cwd.
		if (!args.repo || !args.repo.trim()) {
			console.error("--drive-pr requires --repo <local-path-to-the-pr's-repo-clone>");
			process.exit(1);
		}
		args.text = buildDrivePrPrompt(n, {
			repo: args.repo.trim(),
			scriptsDir: join(repoDir, "skills", "address-pr-feedback", "scripts"),
		});
		args.source = args.source ?? "drive-pr";
		args.dedupeKey = args.dedupeKey ?? `drive-pr:${n}`;
	}
	if (args.text === "") {
		console.error(
			"Usage: toolkit-trigger [--source <s>] [--dedupe <key>] [--no-tadu] <text...>\n" +
				"       toolkit-trigger --cron-job <id>\n" +
				"       toolkit-trigger --drive-pr <pr-number> --repo <local-path-to-repo>",
		);
		process.exit(1);
	}

	const taduTask =
		!args.noTadu && workspaceExists() ? createTaduTask(args.text, args.source) : undefined;

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
