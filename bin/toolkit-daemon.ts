#!/usr/bin/env -S node --experimental-transform-types --no-warnings
/**
 * toolkit-daemon — the resident-agent babysitter.
 *
 * Default: run the daemon (spawn and supervise `pi --mode rpc`, drain the
 * trigger inbox, write daemon-status.json).
 *
 * Provisioning (install is deferred — this never runs systemctl/loginctl/cron):
 *   --print-units            print the env file, launcher, systemd unit, and the
 *                            manual install steps, then exit
 *   --write-units [dir]      write those artefacts to <dir> (default
 *                            ~/.config/<instance>) and print the install steps
 *
 * Config via env: AGENT_TOOLKIT_INSTANCE, AGENT_TOOLKIT_STATE_DIR,
 * AGENT_TOOLKIT_SESSION_DIR, AGENT_TOOLKIT_BRAIN_ROOT, AGENT_TOOLKIT_MODEL,
 * AGENT_TOOLKIT_PI_BIN.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CronJobStore } from "../extensions/cron/jobs.ts";
import { recordDecision, stateDir } from "../extensions/lib/decisions.ts";
import { notify } from "../extensions/lib/notify.ts";
import { brainRoot } from "../extensions/lib/paths.ts";
import { INITIAL_RUNS_STATE, recordRun, type RunsState } from "../extensions/lib/runs.ts";
import { applyCumulativeCost, INITIAL_SPEND_STATE, type SpendState } from "../extensions/lib/spend.ts";
import { writeAnswer } from "../extensions/lib/park.ts";
import { ensureWorkspace, listTasks, taduRoot } from "../extensions/lib/tadu.ts";
import { taduControl } from "../daemon/tadu-control.ts";
import { parseHoursWindow, resolveMinIntervalMinutes } from "../extensions/heartbeat/schedule-gate.ts";
import { Dashboard } from "../daemon/dashboard.ts";
import { checkEnvFileSecurity } from "../daemon/env-secure.ts";
import { FileInbox } from "../daemon/inbox.ts";
import { NotifyWatcher } from "../daemon/notify-watcher.ts";
import {
	type ProvisionConfig,
	renderEnvFile,
	renderInstallInstructions,
	renderLauncher,
	renderSystemdUnit,
} from "../daemon/provision.ts";
import { classifyTrigger } from "../daemon/route.ts";
import { RpcClient } from "../daemon/rpc-client.ts";
import { SlackBridge } from "../daemon/slack.ts";
import { Supervisor } from "../daemon/supervisor.ts";
import { WebhookServer } from "../daemon/webhook-server.ts";
import { WorkerPool } from "../daemon/worker-pool.ts";
import { prepareWorktree } from "../daemon/worktree.ts";

function csv(value: string | undefined): string[] {
	return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Heuristic: is the resident model on subscription/managed auth (Claude Code OAuth
 *  or Codex)? Such auth bills ~$0 per token but has rate-limit windows, so the
 *  heartbeat backs off. A plain API-key provider ("openai"/"anthropic-api") is not. */
function isSubscriptionModel(model: { id?: string; provider?: string } | null | undefined): boolean {
	if (!model) return false;
	const provider = (model.provider ?? "").toLowerCase();
	const id = (model.id ?? "").toLowerCase();
	return provider.includes("anthropic") || provider.includes("codex") || id.includes("claude");
}

const repoDir = join(import.meta.dirname, "..");
const instance = process.env.AGENT_TOOLKIT_INSTANCE ?? "agent-toolkit";
const state = stateDir();
const sessionDir = process.env.AGENT_TOOLKIT_SESSION_DIR ?? join(state, "sessions");
const piBin = process.env.AGENT_TOOLKIT_PI_BIN ?? "pi";
const model = process.env.AGENT_TOOLKIT_MODEL;

function provisionConfig(): ProvisionConfig {
	return {
		instance,
		repoDir,
		daemonEntry: join(repoDir, "bin", "toolkit-daemon.ts"),
		runtime: `${process.execPath} --experimental-transform-types --no-warnings`,
		stateDir: state,
		sessionDir,
		brainRoot: brainRoot(),
		envFile: join(homedir(), ".config", instance, "serve.env"),
		model,
		user: process.env.USER,
		// Bake node/pi paths into the env file so the service works under systemd
		// (where PATH is minimal). Assumes node + pi share a bin dir (nvm/volta/asdf).
		nodeBinDir: dirname(process.execPath),
		// User CLIs (tadu) conventionally live here; needed for the TADU spine.
		userBinDir: join(homedir(), ".local", "bin"),
		piBin: process.env.AGENT_TOOLKIT_PI_BIN ?? join(dirname(process.execPath), "pi"),
	};
}

function printUnits(): void {
	const cfg = provisionConfig();
	const launcherPath = join(homedir(), ".config", instance, "launch.sh");
	const unitPath = join(homedir(), ".config", instance, `${instance}.service`);
	console.log(`# === env file (${cfg.envFile}) ===\n${renderEnvFile(cfg)}`);
	console.log(`# === launcher (${launcherPath}) ===\n${renderLauncher(cfg)}`);
	console.log(`# === systemd unit (${unitPath}) ===\n${renderSystemdUnit(cfg, launcherPath)}`);
	console.log(
		renderInstallInstructions(cfg, {
			unit: unitPath,
			launcher: launcherPath,
			envFile: cfg.envFile,
		}),
	);
}

function writeUnits(targetDir: string): void {
	const cfg = provisionConfig();
	mkdirSync(targetDir, { recursive: true });
	const launcherPath = join(targetDir, "launch.sh");
	const unitPath = join(targetDir, `${instance}.service`);
	writeFileSync(launcherPath, renderLauncher(cfg), "utf8");
	chmodSync(launcherPath, 0o755);
	writeFileSync(unitPath, renderSystemdUnit(cfg, launcherPath), "utf8");
	if (!existsSync(cfg.envFile)) {
		mkdirSync(join(homedir(), ".config", instance), { recursive: true });
		writeFileSync(cfg.envFile, renderEnvFile(cfg), "utf8");
		chmodSync(cfg.envFile, 0o600);
	}
	console.log(`Wrote launcher and unit to ${targetDir} (nothing installed or started).`);
	console.log(
		renderInstallInstructions(cfg, {
			unit: unitPath,
			launcher: launcherPath,
			envFile: cfg.envFile,
		}),
	);
}

/** Refuse to start if the secrets env file is world/group accessible. */
function enforceEnvSecurity(): void {
	const envFile = provisionConfig().envFile;
	const uid = process.getuid?.();
	if (!existsSync(envFile) || uid === undefined) return;
	const st = statSync(envFile);
	const result = checkEnvFileSecurity({ mode: st.mode, uid: st.uid }, uid);
	if (!result.ok) {
		console.error(`[toolkit-daemon] refusing to start: ${result.reason} (${envFile})`);
		process.exit(1);
	}
}

function runDaemon(): void {
	enforceEnvSecurity();
	// Ensure the central TADU work store exists so triggers can attach tasks and
	// the board renders from turn one (best-effort; needs the `tadu` binary).
	if (!ensureWorkspace()) {
		console.error(`[toolkit-daemon] TADU workspace unavailable at ${taduRoot()} (is the 'tadu' binary on PATH?); board will be empty`);
	}
	const inbox = new FileInbox(join(state, "inbox.jsonl"));
	const statusPath = join(state, "daemon-status.json");
	// pi 0.75.5 has no tool-permission prompts; tools run headlessly and the
	// guardrails extension is the safety floor (no --yolo flag exists/needed).
	const piArgs = ["--mode", "rpc", "--continue", "--session-dir", sessionDir];
	if (model) piArgs.push("--model", model);

	const slackConfig = {
		allowedUsers: csv(process.env.SLACK_ALLOWED_USERS),
		botUserId: process.env.SLACK_BOT_USER_ID,
	};
	const ingest = (t: { text: string; source: string; origin?: any }) =>
		inbox.append({ text: t.text, source: t.source, origin: t.origin });

	// Slack Socket Mode bridge (only when configured).
	const slack =
		process.env.SLACK_APP_TOKEN && process.env.SLACK_BOT_TOKEN
			? new SlackBridge({
					appToken: process.env.SLACK_APP_TOKEN,
					botToken: process.env.SLACK_BOT_TOKEN,
					slack: slackConfig,
					onTrigger: ingest,
					logger: (m) => console.error(m),
				})
			: undefined;

	let onReply:
		| ((origin: { kind: string; channel?: string; threadTs?: string; user?: string }, text: string) => void)
		| undefined;
	if (slack) {
		const bridge = slack;
		onReply = (origin, text) => {
			if (origin.kind === "slack" && origin.channel) {
				void bridge.postReply(
					{ kind: "slack", channel: origin.channel, threadTs: origin.threadTs, user: origin.user ?? "" },
					text,
				);
			}
		};
	}

	// Cost/usage guards: pause forwarding once a daily cap is hit. The USD cap
	// suits per-token billing; the runs/day cap is the guard for subscription
	// auth (where cost reads ~$0). Either may pause; both reset daily.
	let currentClient: RpcClient | undefined;
	let spendPaused = false;
	let runsPaused = false;
	const dailyCapUsd = Number(process.env.AGENT_TOOLKIT_DAILY_CAP_USD ?? 0);
	const maxRunsPerDay = Number(process.env.AGENT_TOOLKIT_MAX_RUNS_PER_DAY ?? 0);
	const runsPath = join(state, "runs-state.json");
	let runsState: RunsState = (readJson(runsPath) as RunsState | null) ?? INITIAL_RUNS_STATE;

	// Count one autonomous run against the daily cap. Applies to BOTH the resident
	// forward path and worker delegation, so workers cannot run unbounded.
	const accountRun = (): void => {
		if (maxRunsPerDay <= 0) return;
		const result = recordRun(runsState, { maxPerDay: maxRunsPerDay }, Date.now());
		runsState = result.state;
		writeJson(runsPath, runsState);
		runsPaused = result.overCap;
		if (result.justCrossed) {
			notify(
				{ summary: `Daily run cap (${maxRunsPerDay}) reached; pausing autonomous work until tomorrow.`, kind: "escalate", source: "runs" },
				{ force: true },
			);
		}
	};

	// Worker fleet: discrete tracked work is delegated to a bounded pool of
	// `pi -p` worker sessions so the resident orchestrator never blocks on a long
	// task and independent tasks run concurrently. Workers write their sessions to
	// a separate dir (so --continue never picks one up; the dashboard reads both).
	const workerSessionsDir = join(state, "worker-sessions");
	const workerTreesDir = join(state, "worker-trees");
	const guardrailsPath = join(repoDir, "extensions", "guardrails", "index.ts");
	// Isolation can be disabled (AGENT_TOOLKIT_WORKER_ISOLATION=off) for setups
	// where the base cwd is intentionally shared or not a git repo.
	const isolateWorkers = process.env.AGENT_TOOLKIT_WORKER_ISOLATION !== "off";
	const workerPool = new WorkerPool({
		maxConcurrent: Number(process.env.AGENT_TOOLKIT_WORKER_CONCURRENCY ?? 2),
		sessionDir: workerSessionsDir,
		cwd: process.env.AGENT_TOOLKIT_WORKER_CWD ?? repoDir,
		piBin,
		model,
		stateDir: state,
		// Workers run --no-extensions; re-load just the guardrails safety floor,
		// the slim worktree tools (adopt a PR branch, work across repos), and the
		// park tool (wait for CI/review and resume this same session later).
		guardrailsPath,
		toolExtensions: [
			join(repoDir, "worker-ext", "worktree-tools.ts"),
			join(repoDir, "worker-ext", "park.ts"),
		],
		// Each worker gets its own git worktree (branch worker/<id>) so concurrent
		// workers never collide or dirty the shared checkout.
		worktree: isolateWorkers ? (baseCwd, id) => prepareWorktree(baseCwd, id, workerTreesDir) : undefined,
		timeoutMs: Number(process.env.AGENT_TOOLKIT_WORKER_TIMEOUT_MS ?? 15 * 60_000),
		onDecision: (d) => recordDecision({ kind: d.kind, summary: d.summary, source: d.source ?? "worker", detail: d.detail }),
		onEscalate: (summary) => {
			notify({ summary, kind: "escalate", source: "worker" });
		},
		onNeedsHuman: ({ question, runId, taskId }) => {
			// Push the question now; the detail carries the ref so the dashboard reply
			// box (and a Slack reply) can resume the exact worker. force: a genuine
			// block must never be dropped by the escalation budget — and it can't spam
			// (the worker is parked after one needs_human call until it is answered).
			notify(
				{
					summary: `Needs your decision${taskId ? ` (${taskId})` : ` (reply: --answer ${runId})`}: ${question}`,
					kind: "escalate",
					source: "needs-human",
					detail: { needsHuman: true, runId, taskId },
				},
				{ force: true },
			);
		},
		logger: (m) => console.error(m),
	});

	const supervisor = new Supervisor({
		instance,
		statusPath,
		inbox,
		createClient: () => {
			currentClient = new RpcClient({ command: piBin, args: piArgs, cwd: repoDir, logger: (m) => console.error(m) });
			return currentClient;
		},
		delegate: (trigger) => classifyTrigger(trigger) === "worker",
		dispatchWorker: (trigger) => {
			accountRun();
			workerPool.dispatch(trigger);
		},
		onForward: (trigger) => {
			recordDecision({
				kind: "trigger",
				summary: `Forwarded trigger: ${trigger.text.slice(0, 100)}`,
				source: trigger.source,
				detail: trigger.taduTask ? { taduTask: trigger.taduTask } : undefined,
			});
			accountRun();
		},
		onReply,
		gate: () => spendPaused || runsPaused,
	});

	// Re-arm parked sessions persisted by a previous daemon (waiting on CI/review),
	// so they resume on schedule rather than being treated as orphans.
	workerPool.loadParked();

	// Reconcile orphaned work: any task still in-progress at boot had its worker
	// killed with the previous daemon (the pool's active set is in-memory only) —
	// EXCEPT tasks whose session is parked (legitimately dormant, re-armed above).
	try {
		const control = taduControl();
		const parked = workerPool.parkedTaskIds();
		for (const task of listTasks()) {
			if (task.status !== "in-progress" || parked.has(task.id)) continue;
			control.move(task.id, "blocked");
			control.comment(task.id, "Worker did not finish (daemon restarted); moved to blocked for review.");
			recordDecision({
				kind: "escalate",
				summary: `Task ${task.id} was orphaned by a daemon restart; moved to blocked.`,
				source: "fleet",
				detail: { taduTask: task.id },
			});
		}
	} catch {
		// best-effort; reconcile must never block startup
	}

	supervisor.start();

	let spendTimer: ReturnType<typeof setInterval> | undefined;
	if (dailyCapUsd > 0) {
		const spendPath = join(state, "spend-state.json");
		let spendState: SpendState = (readJson(spendPath) as SpendState | null) ?? INITIAL_SPEND_STATE;
		spendTimer = setInterval(async () => {
			if (!currentClient) return;
			const resp = (await currentClient.request({ type: "get_session_stats" })) as { data?: { cost?: number } } | undefined;
			const cost = resp?.data?.cost;
			if (typeof cost !== "number") return;
			const result = applyCumulativeCost(spendState, cost, { dailyCapUsd }, Date.now());
			spendState = result.state;
			writeJson(spendPath, spendState);
			spendPaused = result.overCap;
			if (result.justCrossed) {
				notify(
					{ summary: `Daily spend cap $${dailyCapUsd} reached; pausing autonomous work until tomorrow.`, kind: "escalate", source: "spend" },
					{ force: true },
				);
			}
		}, 60_000);
	}

	// Detect the resident model so the heartbeat can back off on subscription auth.
	const pollAgentState = async () => {
		if (!currentClient) return;
		const resp = (await currentClient.request({ type: "get_state" })) as
			| { data?: { model?: { id?: string; provider?: string } | null } }
			| undefined;
		const model = resp?.data?.model ?? null;
		writeJson(join(state, "agent-state.json"), {
			authMode: isSubscriptionModel(model) ? "subscription" : "other",
			model: model ? { id: model.id, provider: model.provider } : null,
			ts: new Date().toISOString(),
		});
	};
	const stateTimer = setInterval(() => void pollAgentState(), 60_000);
	const initialStateTimer = setTimeout(() => void pollAgentState(), 8000);

	// Webhook listener (only when a secret is configured).
	const webhook =
		process.env.WEBHOOK_SECRET || process.env.SLACK_SIGNING_SECRET
			? new WebhookServer({
					config: {
						sharedSecret: process.env.WEBHOOK_SECRET,
						slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
						slack: slackConfig,
					},
					onTrigger: ingest,
					port: Number(process.env.WEBHOOK_PORT ?? 8787),
					logger: (m) => console.error(m),
				})
			: undefined;
	if (webhook) webhook.start().catch((e) => console.error(`[webhook] failed to start: ${e}`));
	if (slack) void slack.connect().catch((e) => console.error(`[slack] connect failed: ${e}`));

	// Notify-watcher: deliver the push channel to Slack (when a channel is set).
	const notifyChannel = process.env.SLACK_NOTIFY_CHANNEL;
	let notifyWatcher: NotifyWatcher | undefined;
	if (slack && notifyChannel) {
		const bridge = slack;
		notifyWatcher = new NotifyWatcher({
			post: (text) => {
				void bridge.postMessage(notifyChannel, text);
			},
			// Do-not-disturb: hold routine notices inside the window, flush as one
			// morning batch; escalations still break through.
			quietHours: parseHoursWindow(process.env.AGENT_TOOLKIT_QUIET_HOURS),
			logger: (m) => console.error(m),
		});
		notifyWatcher.start();
	}

	// Oversight dashboard (loopback).
	const dashboard = new Dashboard({
		enqueue: (text) => inbox.append({ text, source: "dashboard" }),
		answer: (ref, text) => writeAnswer(state, ref, text, new Date().toISOString()),
		statusPath,
		sessionsDir: sessionDir,
		workerSessionsDir,
		workerStats: () => ({ active: workerPool.activeCount(), queued: workerPool.queuedCount() }),
		cronJobs: () =>
			new CronJobStore().list().map((j) => {
				// The heartbeat's real cadence is the systemd timer period gated by the
				// min-interval (which the gate skips ticks to honour), not the stored
				// cron string alone. Surface that effective interval so the dashboard
				// can't drift from reality the way a stale stored schedule can.
				if (j.id === "heartbeat") {
					const authMode = (readJson(join(state, "agent-state.json")) as { authMode?: string } | null)?.authMode;
					const minInterval = resolveMinIntervalMinutes(process.env.AGENT_TOOLKIT_HEARTBEAT_MIN_MINUTES, authMode);
					const timerMin = Number(/^\*\/(\d+)/.exec(j.schedule)?.[1] ?? 30);
					const effective = minInterval <= 0 ? timerMin : timerMin * Math.ceil(minInterval / timerMin);
					return {
						id: j.id,
						schedule: `every ${effective} min`,
						description: `timer ${timerMin}m · gate min-interval ${minInterval}m`,
					};
				}
				return { id: j.id, schedule: j.schedule, description: j.description };
			}),
		token: process.env.AGENT_TOOLKIT_DASHBOARD_TOKEN,
		port: Number(process.env.AGENT_TOOLKIT_DASHBOARD_PORT ?? 8788),
		logger: (m) => console.error(m),
	});
	dashboard.start().catch((e) => console.error(`[dashboard] failed to start: ${e}`));

	console.error(
		`[toolkit-daemon] started (instance=${instance}, slack=${slack ? "on" : "off"}, webhook=${webhook ? "on" : "off"}, dashboard=on, workers=${Number(process.env.AGENT_TOOLKIT_WORKER_CONCURRENCY ?? 2)}, spendCap=${dailyCapUsd > 0 ? `$${dailyCapUsd}` : "off"}, runsCap=${maxRunsPerDay > 0 ? maxRunsPerDay : "off"})`,
	);

	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.error("[toolkit-daemon] shutting down…");
		if (spendTimer) clearInterval(spendTimer);
		clearInterval(stateTimer);
		clearTimeout(initialStateTimer);
		notifyWatcher?.stop();
		await dashboard.stop();
		// Stop the supervisor first so the inbox poll can't dispatch into a pool
		// that is shutting down; then drain/kill the workers (bounded).
		await supervisor.stop();
		await workerPool.stop();
		slack?.stop();
		await webhook?.stop();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function writeJson(path: string, value: unknown): void {
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify(value), "utf8");
	} catch {
		// best-effort
	}
}

function main(): void {
	const arg = process.argv[2];
	switch (arg) {
		case "--print-units":
			printUnits();
			return;
		case "--write-units":
			writeUnits(process.argv[3] ?? join(homedir(), ".config", instance));
			return;
		case "--help":
		case "-h":
			console.log(
				"Usage: toolkit-daemon [--print-units | --write-units [dir]]\n\nWith no arguments, runs the daemon. Provisioning flags render install artefacts; installation is deferred (run the printed steps yourself).",
			);
			return;
		default:
			// Guard against a typo'd flag silently starting the daemon.
			if (arg && arg.startsWith("-")) {
				console.error(`Unknown option: ${arg}`);
				console.error("Usage: toolkit-daemon [--print-units | --write-units [dir]]");
				process.exit(1);
			}
			runDaemon();
	}
}

main();
