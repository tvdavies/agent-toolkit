/**
 * Escalation rate-limiter — the anti-thrash rail for notify-after autonomy.
 *
 * Caps how often the agent pushes a notice to the user: at most N per rolling
 * window, with a minimum gap between notices. When the budget is exhausted the
 * caller downgrades from push (Slack/notify) to pull (the decision log only) —
 * it keeps working, it does not spam. Dedupe-by-identity is handled separately
 * (the handled-items store); this is purely the budget + gap.
 *
 * Pure: state in, decision + next state out. Tested directly.
 */

export type EscalationBudget = {
	maxPerWindow: number;
	windowMs: number;
	minGapMs: number;
};

export type EscalationState = {
	windowStartMs: number;
	countInWindow: number;
	lastEscalationMs: number;
};

export const INITIAL_ESCALATION_STATE: EscalationState = {
	windowStartMs: 0,
	countInWindow: 0,
	lastEscalationMs: 0,
};

export const DEFAULT_BUDGET: EscalationBudget = {
	maxPerWindow: 5,
	windowMs: 3_600_000, // 1h
	minGapMs: 120_000, // 2m
};

export type EscalationDecision = {
	allowed: boolean;
	reason?: string;
	state: EscalationState;
};

/**
 * Decide whether an escalation may be pushed now. Rolls the window forward when
 * it has elapsed. On denial the count is unchanged; on approval it increments
 * and records the time.
 */
export function evaluateEscalation(
	state: EscalationState,
	budget: EscalationBudget,
	now: number,
): EscalationDecision {
	const windowElapsed = now - state.windowStartMs >= budget.windowMs;
	const rolled: EscalationState = windowElapsed
		? { windowStartMs: now, countInWindow: 0, lastEscalationMs: state.lastEscalationMs }
		: { ...state };

	if (now - rolled.lastEscalationMs < budget.minGapMs && rolled.lastEscalationMs !== 0) {
		return { allowed: false, reason: "min-gap", state: rolled };
	}
	if (rolled.countInWindow >= budget.maxPerWindow) {
		return { allowed: false, reason: "budget-exhausted", state: rolled };
	}
	return {
		allowed: true,
		state: {
			windowStartMs: rolled.windowStartMs === 0 ? now : rolled.windowStartMs,
			countInWindow: rolled.countInWindow + 1,
			lastEscalationMs: now,
		},
	};
}
