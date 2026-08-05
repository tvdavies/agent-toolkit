/**
 * Drive-to-green — the daemon adapter around the shared PR readiness protocol.
 *
 * The canonical blocker classification, thread handling, and ready-to-merge
 * criteria live in skills/_shared/pr-readiness/PROTOCOL.md. This module adds
 * only daemon-specific worktree isolation and park/resume behaviour.
 */

export const DRIVE_PR_MARKER = "[drive-pr";

export function isDrivePrPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(DRIVE_PR_MARKER);
}

export function parseDrivePrNumber(prompt: string): number | undefined {
	const match = /^\[drive-pr\s+#?(\d+)\]/.exec(prompt.trimStart());
	return match ? Number(match[1]) : undefined;
}

export type DrivePrOptions = {
	/** Local filesystem path to the PR's repo clone; the worker adopts the PR branch there. */
	repo: string;
	/** Absolute directory containing PROTOCOL.md and scripts/. */
	readinessDir: string;
};

export function buildDrivePrPrompt(prNumber: number, opts: DrivePrOptions): string {
	const repo = opts.repo.trim();
	const readiness = opts.readinessDir;
	const protocol = `${readiness}/PROTOCOL.md`;
	const scripts = `${readiness}/scripts`;
	const resume = `Resume driving PR #${prNumber}: re-adopt its worktree, read the shared readiness protocol, fetch current blockers and authoritative state, address actionable work, then finish or park.`;
	return [
		`[drive-pr #${prNumber}] Autonomously drive GitHub PR #${prNumber} in ${repo} to the ready-to-merge state defined by ${protocol}. Act and report; do not ask for routine approval.`,
		``,
		`SHARED CONTRACT:`,
		`- Read ${protocol} at the start of every cycle. It is authoritative for blocker classification, check state, push-before-resolve ordering, bot/human thread handling, readiness criteria, and no-progress exits.`,
		`- Use ${scripts}/fetch-pr-blockers.sh and ${scripts}/reply-and-resolve.sh exactly as documented there.`,
		``,
		`DAEMON ADAPTER:`,
		`1. Isolate the PR branch with worktree_adopt { pr: ${prNumber}, repo: "${repo}" }. Call the returned absolute path WT. Reusing the same worktree on resumed cycles is expected.`,
		`2. Anchor every command to WT with \`cd "<WT>" && ...\` or an explicit working directory. A prior cd does not persist. Resolve the repo slug once and pass it explicitly to gh calls when needed.`,
		`3. Fetch the shared blocker inventory and authoritative GitHub state for the current head. Do not treat absence of failures or threads as proof of readiness.`,
		`4. If every shared readiness criterion holds, report READY TO MERGE and finish. Never merge the PR.`,
		`5. If checks or expected automated review are pending, or a push just changed the head, call park { seconds: 180, prompt: "${resume}", reason: "waiting for current-head PR readiness" } and end the turn immediately.`,
		`6. If actionable blockers exist, triage and address them autonomously in WT, scoped strictly to the feedback. Read failed logs and fix root causes; rerun only verified flakes.`,
		`7. Commit and push only to the PR head branch. Never force-push or push to a protected/base branch. After the push, reply and resolve threads through the shared script and matrix, then park for a fresh current-head cycle.`,
		`8. Track the cycle marker. If the shared no-progress or escalation rule fires, report the exact blocker and finish instead of parking again.`,
	].join("\n");
}
