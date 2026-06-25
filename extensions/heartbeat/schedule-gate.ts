/**
 * Heartbeat schedule gate (pure).
 *
 * The timer (systemd/cron) fires the heartbeat; this gate decides whether it
 * should actually RUN now, so the effective cadence is `max(timer, minInterval)`
 * regardless of how often the timer fires — and so heartbeats stay inside an
 * optional active-hours window. toolkit-trigger applies it before queuing.
 *
 * Mirrors OpenClaw/Hermes: a minimum interval (defaulted higher on Anthropic
 * subscription auth, where a too-frequent heartbeat would burn the rate-limit
 * window) plus an optional quiet-hours window.
 */

export type HoursWindow = { startMin: number; endMin: number };

export type HeartbeatGateConfig = {
	minIntervalMin: number;
	/** Active window (heartbeats only run inside it). Omit to allow any time. */
	activeHours?: HoursWindow;
};

export type HeartbeatGateState = { lastRunMs: number };

export type GateVerdict = { run: boolean; reason?: string };

/**
 * Tolerance applied to the min-interval comparison.
 *
 * The timer fires on a fixed period and `lastRunMs` is stamped a few hundred ms
 * AFTER the tick that ran (after the inbox append), whereas the next tick's gate
 * check samples the clock slightly before that point. So a tick landing exactly
 * one interval later measures a hair UNDER the interval and would wrongly skip —
 * aliasing the effective cadence to 1.5–2× the target (a 60-min interval on a
 * 30-min timer drifts to an irregular 60/90; a 30-min interval on a 30-min timer
 * halves to 60). Treat a tick within this tolerance of the interval as due. It is
 * clamped to at most half the interval (see `shouldRunHeartbeat`) so it can never
 * admit a genuinely-early tick — those are always at least a half-period away.
 */
const INTERVAL_GRACE_MS = 90_000;

/**
 * Resolve the effective minimum minutes between heartbeats. An explicit env value
 * wins (0 disables gating); otherwise default to hourly on subscription/managed
 * auth (Claude Code OAuth, Codex — where a too-frequent heartbeat burns the
 * rate-limit window), else 30 minutes. Mirrors OpenClaw's OAuth back-off.
 */
export function resolveMinIntervalMinutes(
	envValue: string | undefined,
	authMode: string | undefined,
): number {
	const explicit = Number(envValue);
	if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
	return authMode === "subscription" || authMode === "anthropic" ? 60 : 30;
}

/** Parse "07:00-23:00" into minutes-of-day. Returns undefined if malformed. */
export function parseHoursWindow(spec: string | undefined): HoursWindow | undefined {
	if (!spec) return undefined;
	const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec.trim());
	if (!match) return undefined;
	const [sh, sm, eh, em] = [match[1], match[2], match[3], match[4]].map(Number) as [number, number, number, number];
	if (sh > 23 || eh > 23 || sm > 59 || em > 59) return undefined;
	return { startMin: sh * 60 + sm, endMin: eh * 60 + em };
}

/** Whether minutes-of-day t falls in [start, end) (handles windows crossing midnight). */
function inWindow(t: number, window: HoursWindow): boolean {
	const { startMin, endMin } = window;
	if (startMin === endMin) return true; // degenerate: always active
	return startMin < endMin
		? t >= startMin && t < endMin
		: t >= startMin || t < endMin; // overnight window
}

/** Decide whether a heartbeat may run now. `now` is injected for testability. */
export function shouldRunHeartbeat(
	state: HeartbeatGateState,
	config: HeartbeatGateConfig,
	now: Date,
): GateVerdict {
	if (config.activeHours) {
		const minutesOfDay = now.getHours() * 60 + now.getMinutes();
		if (!inWindow(minutesOfDay, config.activeHours)) {
			return { run: false, reason: "quiet-hours" };
		}
	}
	const intervalMs = config.minIntervalMin * 60_000;
	// Apply a small grace so a tick that lands a hair under the interval (clock
	// sampled just before `lastRunMs` was stamped) still counts as due, rather
	// than skipping and aliasing the cadence to the next tick. Clamp to half the
	// interval so a genuinely-early (half-period) tick can never slip through.
	const graceMs = Math.min(INTERVAL_GRACE_MS, intervalMs / 2);
	const elapsedMs = now.getTime() - state.lastRunMs;
	if (elapsedMs < intervalMs - graceMs) {
		return { run: false, reason: "min-interval" };
	}
	return { run: true };
}
