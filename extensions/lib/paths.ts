/**
 * Shared path resolution for the toolkit. Kept in lib/ so multiple extensions
 * agree on where durable state lives without importing each other.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The OKF brain bundle (env-overridable). */
export function brainRoot(): string {
	return (
		process.env.AGENT_TOOLKIT_BRAIN_ROOT ??
		join(homedir(), ".local", "share", "agent-toolkit", "brain")
	);
}

/** Candidate roots under which Pi persists workflow runs. */
export function workflowRunRoots(cwd: string): string[] {
	return [
		join(homedir(), ".pi", "agent", "workflow-runs"),
		join(homedir(), ".pi", "workflow-runs"),
		join(cwd, ".pi", "workflow-runs"),
	];
}
