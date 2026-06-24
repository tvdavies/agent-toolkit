/**
 * Exponential restart backoff for the resident RPC process.
 *
 * A crash-looping child must not be respawned in a tight loop. After a stable
 * run the attempt counter resets (handled by the supervisor); this module is the
 * pure delay calculation.
 */

export type BackoffOptions = {
	baseMs?: number;
	maxMs?: number;
	factor?: number;
};

/** Delay before restart attempt N (1-based): base * factor^(N-1), capped at max. */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
	const base = options.baseMs ?? 500;
	const max = options.maxMs ?? 30_000;
	const factor = options.factor ?? 2;
	const n = Math.max(1, Math.floor(attempt));
	const delay = base * factor ** (n - 1);
	return Math.min(max, Math.round(delay));
}
