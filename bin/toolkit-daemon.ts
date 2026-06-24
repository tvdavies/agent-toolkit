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
import { join } from "node:path";
import { CronJobStore } from "../extensions/cron/jobs.ts";
import { recordDecision, stateDir } from "../extensions/lib/decisions.ts";
import { notify } from "../extensions/lib/notify.ts";
import { brainRoot } from "../extensions/lib/paths.ts";
import { applyCumulativeCost, INITIAL_SPEND_STATE, type SpendState } from "../extensions/lib/spend.ts";
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
import { RpcClient } from "../daemon/rpc-client.ts";
import { SlackBridge } from "../daemon/slack.ts";
import { Supervisor } from "../daemon/supervisor.ts";
import { WebhookServer } from "../daemon/webhook-server.ts";

function csv(value: string | undefined): string[] {
	return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
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
	const inbox = new FileInbox(join(state, "inbox.jsonl"));
	const statusPath = join(state, "daemon-status.json");
	const piArgs = ["--mode", "rpc", "--continue", "--yolo", "--session-dir", sessionDir];
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

	// Spend cap: when configured, pause forwarding once the daily cap is hit.
	let currentClient: RpcClient | undefined;
	let paused = false;
	const dailyCapUsd = Number(process.env.AGENT_TOOLKIT_DAILY_CAP_USD ?? 0);

	const supervisor = new Supervisor({
		instance,
		statusPath,
		inbox,
		createClient: () => {
			currentClient = new RpcClient({ command: piBin, args: piArgs, cwd: repoDir, logger: (m) => console.error(m) });
			return currentClient;
		},
		onForward: (trigger) =>
			recordDecision({
				kind: "trigger",
				summary: `Forwarded trigger: ${trigger.text.slice(0, 100)}`,
				source: trigger.source,
				detail: trigger.taduTask ? { taduTask: trigger.taduTask } : undefined,
			}),
		onReply,
		gate: () => paused,
	});
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
			paused = result.overCap;
			if (result.justCrossed) {
				notify(
					{ summary: `Daily spend cap $${dailyCapUsd} reached; pausing autonomous work until tomorrow.`, kind: "escalate", source: "spend" },
					{ force: true },
				);
			}
		}, 60_000);
	}

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
	if (webhook) void webhook.start();
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
			logger: (m) => console.error(m),
		});
		notifyWatcher.start();
	}

	// Oversight dashboard (loopback).
	const dashboard = new Dashboard({
		enqueue: (text) => inbox.append({ text, source: "dashboard" }),
		statusPath,
		cronJobs: () =>
			new CronJobStore().list().map((j) => ({ id: j.id, schedule: j.schedule, description: j.description })),
		token: process.env.AGENT_TOOLKIT_DASHBOARD_TOKEN,
		port: Number(process.env.AGENT_TOOLKIT_DASHBOARD_PORT ?? 8788),
		logger: (m) => console.error(m),
	});
	void dashboard.start();

	console.error(
		`[toolkit-daemon] started (instance=${instance}, slack=${slack ? "on" : "off"}, webhook=${webhook ? "on" : "off"}, dashboard=on, spendCap=${dailyCapUsd > 0 ? `$${dailyCapUsd}` : "off"})`,
	);

	const shutdown = async () => {
		console.error("[toolkit-daemon] shutting down…");
		if (spendTimer) clearInterval(spendTimer);
		notifyWatcher?.stop();
		await dashboard.stop();
		await supervisor.stop();
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
			runDaemon();
	}
}

main();
