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
	const elapsedMs = now.getTime() - state.lastRunMs;
	if (elapsedMs < config.minIntervalMin * 60_000) {
		return { run: false, reason: "min-interval" };
	}
	return { run: true };
}
