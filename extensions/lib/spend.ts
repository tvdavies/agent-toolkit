/**
 * Spend accountant — the daily cost guard for unattended autonomy.
 *
 * Pi reports cumulative session cost; this turns that into a per-day spend and
 * decides whether the daily cap is exceeded. Pure (state in, state + verdict
 * out); the daemon persists the state and feeds it the cumulative cost from
 * get_session_stats, pausing trigger forwarding when over cap.
 */

const DAY_MS = 86_400_000;

export type SpendConfig = {
	/** Hard daily cap in USD. */
	dailyCapUsd: number;
};

export type SpendState = {
	dayStartMs: number;
	spentTodayUsd: number;
	/** Last cumulative session cost seen, to compute deltas. */
	lastCumulativeUsd: number;
};

export const INITIAL_SPEND_STATE: SpendState = {
	dayStartMs: 0,
	spentTodayUsd: 0,
	lastCumulativeUsd: 0,
};

export type SpendResult = {
	state: SpendState;
	overCap: boolean;
	/** True only on the transition from under to over (for one-shot notify). */
	justCrossed: boolean;
};

/**
 * Fold a fresh cumulative session cost into the daily spend. Resets at the day
 * boundary; cumulative drops (e.g. a session reset) are treated as a fresh
 * baseline rather than negative spend.
 */
export function applyCumulativeCost(
	state: SpendState,
	cumulativeUsd: number,
	config: SpendConfig,
	now: number,
): SpendResult {
	let next: SpendState;
	if (state.dayStartMs === 0 || now - state.dayStartMs >= DAY_MS) {
		next = { dayStartMs: now, spentTodayUsd: 0, lastCumulativeUsd: cumulativeUsd };
	} else {
		const delta = Math.max(0, cumulativeUsd - state.lastCumulativeUsd);
		next = {
			dayStartMs: state.dayStartMs,
			spentTodayUsd: state.spentTodayUsd + delta,
			lastCumulativeUsd: cumulativeUsd,
		};
	}
	const wasOver = state.spentTodayUsd >= config.dailyCapUsd && state.dayStartMs !== 0;
	const overCap = next.spentTodayUsd >= config.dailyCapUsd;
	return { state: next, overCap, justCrossed: overCap && !wasOver };
}
