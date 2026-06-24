#!/usr/bin/env -S node --experimental-transform-types --no-warnings
/**
 * toolkit-digest — the low-attention "what did my agent do" summary.
 *
 * Reads the decision spine, builds a deterministic (no-LLM) digest over a
 * window, prints it, and pushes it to the notify channel (which the daemon's
 * notify-watcher delivers to Slack). Schedule it from cron, or run it by hand.
 *
 * Usage: toolkit-digest [--since-hours N]   (default 24)
 */

import { readRecent } from "../extensions/lib/decisions.ts";
import { summarizeDecisions } from "../extensions/lib/digest.ts";
import { notify } from "../extensions/lib/notify.ts";

function main(): void {
	const argv = process.argv.slice(2);
	const idx = argv.indexOf("--since-hours");
	const hours = idx >= 0 ? Number(argv[idx + 1]) : 24;
	const sinceMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000;

	const decisions = readRecent(5000);
	const digest = summarizeDecisions(decisions, { sinceMs });

	console.log(digest);
	// Force-push: a scheduled digest should always be delivered, not rate-limited.
	notify({ summary: digest, kind: "digest", source: "digest" }, { force: true });
}

main();
