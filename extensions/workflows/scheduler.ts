function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Workflow agent admission was aborted.");
}

interface Waiter {
	signal: AbortSignal;
	resolve: (release: () => void) => void;
	reject: (error: Error) => void;
	onAbort: () => void;
}

/** Process-wide fair, abort-aware admission for workflow children. */
export class AbortableScheduler {
	private active = 0;
	private readonly queue: Waiter[] = [];

	constructor(readonly limit: number) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error("Scheduler limit must be a positive integer.");
	}

	get activeCount(): number { return this.active; }
	get queuedCount(): number { return this.queue.length; }

	acquire(signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) return Promise.reject(abortReason(signal));
		return new Promise<() => void>((resolve, reject) => {
			const waiter: Waiter = {
				signal,
				resolve,
				reject,
				onAbort: () => {
					const index = this.queue.indexOf(waiter);
					if (index >= 0) this.queue.splice(index, 1);
					reject(abortReason(signal));
				},
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
			this.queue.push(waiter);
			this.pump();
		});
	}

	private pump(): void {
		while (this.active < this.limit && this.queue.length > 0) {
			const waiter = this.queue.shift()!;
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal.aborted) {
				waiter.reject(abortReason(waiter.signal));
				continue;
			}
			this.active++;
			let released = false;
			waiter.resolve(() => {
				if (released) return;
				released = true;
				this.active--;
				this.pump();
			});
		}
	}
}
