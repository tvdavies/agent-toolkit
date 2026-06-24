/**
 * Runs accountant — a per-day cap on autonomous agent runs.
 *
 * The subscription-relevant guard: when usage is billed to a Claude/Codex
 * subscription rather than per-token, the USD spend cap reads ~$0 and never
 * trips. Counting runs/day instead bounds how much of the subscription's
 * rate-limit window the agent can consume unattended.
 *
 * Pure (state in, state + verdict out); the daemon persists state and ticks it
 * per forwarded trigger, pausing forwarding once over the cap.
 */

const DAY_MS = 86_400_000;

export type RunsConfig = {
	/** Max autonomous runs per rolling day. */
	maxPerDay: number;
};

export type RunsState = {
	dayStartMs: number;
	count: number;
};

export const INITIAL_RUNS_STATE: RunsState = { dayStartMs: 0, count: 0 };

export type RunsResult = {
	state: RunsState;
	overCap: boolean;
	/** True only on the transition from under to over (for one-shot notify). */
	justCrossed: boolean;
};

/** Record one run; reset at the day boundary. Over cap once count reaches max. */
export function recordRun(state: RunsState, config: RunsConfig, now: number): RunsResult {
	const sameDay = state.dayStartMs !== 0 && now - state.dayStartMs < DAY_MS;
	const next: RunsState = sameDay
		? { dayStartMs: state.dayStartMs, count: state.count + 1 }
		: { dayStartMs: now, count: 1 };
	const wasOver = sameDay && state.count >= config.maxPerDay;
	const overCap = next.count >= config.maxPerDay;
	return { state: next, overCap, justCrossed: overCap && !wasOver };
}
