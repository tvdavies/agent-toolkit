/**
 * Heartbeat protocol — the shared contract between the cron job that fires a
 * heartbeat and the heartbeat extension that recognises it.
 *
 * A heartbeat is just a trigger whose prompt begins with a marker. The cron job
 * queues `buildHeartbeatPrompt()`; the extension detects the marker on
 * before_agent_start and injects the checklist + silence rule. Pure, no deps.
 */

export const HEARTBEAT_MARKER = "[heartbeat]";

/** Whether a prompt is a heartbeat run. */
export function isHeartbeatPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(HEARTBEAT_MARKER);
}

/** The prompt a heartbeat trigger carries. */
export function buildHeartbeatPrompt(): string {
	return `${HEARTBEAT_MARKER} Run your scheduled heartbeat check. Follow your HEARTBEAT.md checklist. Do whatever needs doing, but stay silent unless something genuinely needs the user's attention — record routine work to the heartbeat log and escalate only what matters.`;
}
