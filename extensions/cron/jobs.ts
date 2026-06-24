/**
 * Cron job store — the managed set of scheduled jobs, persisted as JSON.
 *
 * Each job's prompt text lives here (not on the crontab line), so cron lines stay
 * quoting-free (`toolkit-trigger --cron-job <id>`) and the text is edited without
 * touching the crontab. `toolkit-trigger --cron-job <id>` and the /cron command
 * both read this store, so it is plain fs with no Pi imports.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHeartbeatPrompt } from "../heartbeat/protocol.ts";
import { stateDir } from "../lib/decisions.ts";

export type CronJob = {
	/** Stable slug used on the crontab line and as the trigger source suffix. */
	id: string;
	/** Standard 5-field cron schedule (minute hour day-of-month month weekday). */
	schedule: string;
	/** Prompt text delivered to the agent when the job fires. */
	text: string;
	/** Trigger source label; defaults to cron:<id>. */
	source?: string;
	/** Short human description shown in /cron list and crontab comments. */
	description?: string;
};

export function cronJobsPath(): string {
	return join(stateDir(), "cron-jobs.json");
}

/** Jobs seeded on first use. Only the heartbeat ships by default — other jobs
 *  (digest, brain-consolidate) arrive with their handlers in later phases. */
export function defaultJobs(): CronJob[] {
	return [
		{
			id: "heartbeat",
			schedule: "*/30 * * * *",
			text: buildHeartbeatPrompt(),
			source: "cron:heartbeat",
			description: "Heartbeat check (every 30 min)",
		},
	];
}

export class CronJobStore {
	private readonly path: string;

	constructor(path: string = cronJobsPath()) {
		this.path = path;
	}

	list(): CronJob[] {
		if (!existsSync(this.path)) return [];
		try {
			const data = JSON.parse(readFileSync(this.path, "utf8"));
			return Array.isArray(data) ? (data as CronJob[]) : [];
		} catch {
			return [];
		}
	}

	get(id: string): CronJob | undefined {
		return this.list().find((job) => job.id === id);
	}

	/** Insert or replace a job by id. */
	add(job: CronJob): void {
		const jobs = this.list().filter((existing) => existing.id !== job.id);
		jobs.push(job);
		this.write(jobs);
	}

	remove(id: string): boolean {
		const jobs = this.list();
		const next = jobs.filter((job) => job.id !== id);
		if (next.length === jobs.length) return false;
		this.write(next);
		return true;
	}

	/** Add any default jobs not already present. Returns the ids added. */
	seedDefaults(): string[] {
		const have = new Set(this.list().map((job) => job.id));
		const added: string[] = [];
		for (const job of defaultJobs()) {
			if (!have.has(job.id)) {
				this.add(job);
				added.push(job.id);
			}
		}
		return added;
	}

	private write(jobs: CronJob[]): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
	}
}
