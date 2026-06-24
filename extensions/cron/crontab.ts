/**
 * Managed-crontab rendering — pure functions to render and splice an
 * agent-toolkit-owned block into the user's crontab without disturbing other
 * entries.
 *
 * Cron lines deliberately carry only a job id (`toolkit-trigger --cron-job <id>`)
 * — the prompt text lives in the jobs store (./jobs), so the shell command needs
 * no fragile quoting. Each line takes a non-blocking per-job flock so overlapping
 * runs are skipped, and sources the env file so the trigger sees toolkit paths.
 *
 * No fs/Pi imports — splicing and parsing are unit-tested directly.
 */

import type { CronJob } from "./jobs.ts";

export const MANAGED_BEGIN = "# BEGIN AGENT-TOOLKIT MANAGED JOBS";
export const MANAGED_END = "# END AGENT-TOOLKIT MANAGED JOBS";

export type CronRenderContext = {
	/** Command that runs TypeScript, e.g. "node --experimental-transform-types". */
	runtime: string;
	/** Absolute path to bin/toolkit-trigger.ts. */
	triggerBin: string;
	/** Env file sourced before running (carries AGENT_TOOLKIT_* paths). */
	envFile: string;
	/** Directory for per-job lock files. */
	lockDir?: string;
};

/** Render the shell command (after the schedule) for one job. */
export function renderJobCommand(job: CronJob, ctx: CronRenderContext): string {
	const lockDir = ctx.lockDir ?? "/tmp";
	const lock = `${lockDir}/agent-toolkit-cron-${job.id}.lock`;
	// Only fixed, slug/path tokens reach the shell — no user free-text — so the
	// single-quoted -c script needs no inner escaping.
	const script = `. ${ctx.envFile} 2>/dev/null; exec ${ctx.runtime} ${ctx.triggerBin} --cron-job ${job.id}`;
	return `flock -n ${lock} /bin/sh -c '${script}'`;
}

/** Render the full managed block (markers + one line per job). */
export function renderManagedBlock(jobs: CronJob[], ctx: CronRenderContext): string {
	const lines = [
		MANAGED_BEGIN,
		"# Managed by agent-toolkit (edit via /cron). Do not hand-edit between markers.",
	];
	for (const job of jobs) {
		lines.push(`# job:${job.id}${job.description ? ` — ${job.description}` : ""}`);
		lines.push(`${job.schedule} ${renderJobCommand(job, ctx)}`);
	}
	lines.push(MANAGED_END);
	return lines.join("\n");
}

const blockPattern = new RegExp(
	`${escapeRegExp(MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`,
);

/** Return the managed block found in a crontab, or "" if absent. */
export function extractManagedBlock(crontab: string): string {
	const match = blockPattern.exec(crontab);
	return match ? match[0].replace(/\n+$/, "") : "";
}

/**
 * Splice the managed block into a crontab: replace an existing managed block in
 * place, or append it. All non-managed lines are preserved verbatim. Passing an
 * empty `block` removes the managed block entirely.
 */
export function replaceManagedBlock(crontab: string, block: string): string {
	const existing = crontab.replace(/\s+$/, "");
	const hasBlock = blockPattern.test(existing);

	if (block === "") {
		if (!hasBlock) return crontab;
		return `${existing.replace(blockPattern, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "")}\n`;
	}
	if (hasBlock) {
		return `${existing.replace(blockPattern, block).replace(/\s+$/, "")}\n`;
	}
	return existing === "" ? `${block}\n` : `${existing}\n\n${block}\n`;
}

/** Parse the job ids present in a managed block (from the --cron-job tokens). */
export function parseJobIds(crontab: string): string[] {
	const block = extractManagedBlock(crontab);
	const ids: string[] = [];
	for (const match of block.matchAll(/--cron-job\s+([\w-]+)/g)) {
		if (match[1]) ids.push(match[1]);
	}
	return ids;
}

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
