/**
 * Notify-watcher — delivers the push channel to Slack.
 *
 * Extensions append escalations to notify.jsonl (rate-limited by the notify
 * lib). This watcher tails new notices and posts them to a Slack channel. On
 * start it skips the existing backlog (it only delivers what happens from now),
 * so a restart never re-pings old notices.
 *
 * The `post` function is injected (the daemon supplies slack.postMessage), so
 * this is tested without Slack.
 */

import { readNotices } from "../extensions/lib/notify.ts";

export type NotifyWatcherOptions = {
	/** Deliver a formatted notice (e.g. to Slack). */
	post: (text: string) => void | Promise<void>;
	intervalMs?: number;
	logger?: (message: string) => void;
};

export class NotifyWatcher {
	private readonly o: NotifyWatcherOptions;
	private cursor = 0;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: NotifyWatcherOptions) {
		this.o = options;
	}

	/** Begin watching, skipping the current backlog. */
	start(): void {
		this.cursor = readNotices().length;
		this.timer = setInterval(() => this.pollOnce(), this.o.intervalMs ?? 2000);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Deliver any notices appended since the last poll. Public for tests. */
	pollOnce(): void {
		const all = readNotices();
		if (all.length <= this.cursor) return;
		const fresh = all.slice(this.cursor);
		this.cursor = all.length;
		for (const notice of fresh) {
			void Promise.resolve(this.o.post(formatNotice(notice.summary, notice.kind))).catch(() =>
				this.o.logger?.("[notify] delivery failed"),
			);
		}
	}
}

function formatNotice(summary: string, kind: string): string {
	const icon = kind === "escalate" ? "⚠️" : "ℹ️";
	return `${icon} ${summary}`;
}
