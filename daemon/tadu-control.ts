/**
 * TADU control — the write side of the spine (the adapter in extensions/lib/tadu
 * is read-only). Thin wrappers over the `tadu` CLI, run in the central workspace,
 * so the worker pool can drive a task's lifecycle (move it across lanes, append
 * the decision log) and so the dashboard can apply a human's board actions.
 *
 * Two surfaces, distinguished only by the recorded actor (see ./tadu-actor):
 *  - {@link taduControl} stamps the agent actor — the system's own writes.
 *  - {@link humanTaduControl} stamps the human — a board drag/comment, which the
 *    watch loop is meant to react to. Keeping these apart is the echo-loop guard.
 *
 * Best-effort: a missing `tadu` binary or absent workspace must never break the
 * caller — visibility degrades, work continues. The runner is injectable so both
 * the pool and the dashboard are tested without the CLI.
 */

import { spawnSync } from "node:child_process";
import { agentTaduEnv, humanTaduEnv } from "../extensions/lib/tadu-actor.ts";
import { taduRoot } from "../extensions/lib/tadu.ts";

export type TaduRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string };

/** A runner that shells the `tadu` CLI with the given environment (sets the actor). */
function cliRunner(env: NodeJS.ProcessEnv): TaduRunner {
	return (args) => {
		const r = spawnSync("tadu", args, { cwd: taduRoot(), encoding: "utf8", timeout: 5000, env });
		return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	};
}

const agentRunner: TaduRunner = cliRunner(agentTaduEnv());

export type TaduControl = {
	move: (taskId: string, status: string) => boolean;
	comment: (taskId: string, text: string) => boolean;
};

function build(runner: TaduRunner): TaduControl {
	const run = (args: string[]): boolean => {
		try {
			return runner(args).status === 0;
		} catch {
			return false;
		}
	};
	// `--` ends flag parsing: user-controlled text/ids can never be smuggled in as a
	// tadu flag (e.g. a comment of `--file=<secrets path>` would otherwise read that
	// file into the comment — an arbitrary-file-read primitive). Verified against the
	// installed Cobra-based tadu.
	return {
		move: (taskId, status) => run(["move", "--", taskId, status]),
		comment: (taskId, text) => run(["comment", "--", taskId, text]),
	};
}

/** Agent-actored control surface (the pool's lifecycle writes). Pass a runner in tests. */
export function taduControl(runner: TaduRunner = agentRunner): TaduControl {
	return build(runner);
}

/** Human-actored control surface (the dashboard applying a board drag/comment). */
export function humanTaduControl(runner: TaduRunner = cliRunner(humanTaduEnv())): TaduControl {
	return build(runner);
}
