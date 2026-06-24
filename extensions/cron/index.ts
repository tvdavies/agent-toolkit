/**
 * Cron extension — durable scheduling via the user's crontab.
 *
 * Where scheduler.ts handles *in-session, ephemeral* timers ("check this PR in
 * 10m" — lost on full restart), cron handles *durable, periodic* jobs that
 * survive reboot. Each job is a managed crontab line that runs
 * `toolkit-trigger --cron-job <id>`, dropping a trigger the daemon forwards to
 * the resident agent. The job's prompt text lives in the JSON store (./jobs).
 *
 * Installation is deferred: `/cron print` renders the new crontab to a file for
 * you to apply with `crontab <file>`. Nothing here mutates your crontab.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stateDir } from "../lib/decisions.ts";
import {
	type CronRenderContext,
	parseJobIds,
	renderManagedBlock,
	replaceManagedBlock,
} from "./crontab.ts";
import { type CronJob, CronJobStore } from "./jobs.ts";

function repoDir(): string {
	return join(import.meta.dirname, "..", "..");
}

function renderContext(): CronRenderContext {
	return {
		runtime: `${process.execPath} --experimental-transform-types --no-warnings`,
		triggerBin: join(repoDir(), "bin", "toolkit-trigger.ts"),
		envFile: join(homedir(), ".config", "agent-toolkit", "serve.env"),
		lockDir: "/tmp",
	};
}

function currentCrontab(): string {
	try {
		const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });
		return result.status === 0 ? result.stdout : "";
	} catch {
		return "";
	}
}

export default function cronExtension(pi: ExtensionAPI): void {
	const store = new CronJobStore();
	store.seedDefaults();

	pi.registerCommand("cron", {
		description: "Durable scheduling: /cron list | add <id> <m h dom mon dow> <text> | remove <id> | print",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "list", label: "list — show managed jobs and install state" },
				{ value: "add ", label: "add — add a job: <id> <5-field schedule> <text>" },
				{ value: "remove ", label: "remove — remove a job by id" },
				{ value: "print", label: "print — render the crontab and show how to apply" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const command = tokens[0] ?? "list";

			if (command === "list") {
				const installed = new Set(parseJobIds(currentCrontab()));
				const jobs = store.list();
				const lines = jobs.length === 0 ? ["No cron jobs."] : jobs.map(
					(job) =>
						`${installed.has(job.id) ? "✓" : "·"} ${job.id}  ${job.schedule}  — ${job.description ?? job.text.slice(0, 50)}`,
				);
				ctx.ui.notify(["Cron jobs (✓ = installed in crontab):", ...lines].join("\n"), "info");
				return;
			}

			if (command === "add") {
				const id = tokens[1];
				const schedule = tokens.slice(2, 7).join(" ");
				const text = tokens.slice(7).join(" ");
				if (!id || !/^[\w-]+$/.test(id) || tokens.slice(2, 7).length < 5 || !text) {
					ctx.ui.notify("Usage: /cron add <id> <m h dom mon dow> <text>", "warning");
					return;
				}
				const job: CronJob = { id, schedule, text, source: `cron:${id}` };
				store.add(job);
				ctx.ui.notify(`Added cron job "${id}" (${schedule}). Run /cron print to install.`, "info");
				return;
			}

			if (command === "remove") {
				const id = tokens[1];
				if (!id) {
					ctx.ui.notify("Usage: /cron remove <id>", "warning");
					return;
				}
				ctx.ui.notify(
					store.remove(id)
						? `Removed cron job "${id}". Run /cron print to update the crontab.`
						: `No cron job "${id}".`,
					store.get(id) ? "warning" : "info",
				);
				return;
			}

			if (command === "print") {
				const block = renderManagedBlock(store.list(), renderContext());
				const rendered = replaceManagedBlock(currentCrontab(), block);
				const outPath = join(stateDir(), "crontab.rendered");
				try {
					mkdirSync(stateDir(), { recursive: true });
					writeFileSync(outPath, rendered, "utf8");
				} catch {
					// fall through — still show the block
				}
				ctx.ui.notify(
					[
						"Rendered crontab (managed block):",
						"",
						block,
						"",
						`Full crontab written to: ${outPath}`,
						`To apply (review first):  crontab ${outPath}`,
						"Nothing was installed automatically.",
					].join("\n"),
					"info",
				);
				return;
			}

			ctx.ui.notify(
				"Usage: /cron list | add <id> <m h dom mon dow> <text> | remove <id> | print",
				"warning",
			);
		},
	});
}
