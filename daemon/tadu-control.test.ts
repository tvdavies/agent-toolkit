import { describe, expect, it } from "bun:test";
import { humanTaduControl, type TaduRunner, taduControl } from "./tadu-control";

const capture = (): { runner: TaduRunner; calls: string[][] } => {
	const calls: string[][] = [];
	const runner: TaduRunner = (args) => {
		calls.push(args);
		return { status: 0, stdout: "", stderr: "" };
	};
	return { runner, calls };
};

describe("tadu-control argument safety", () => {
	it("inserts a -- end-of-flags separator so user input can't smuggle a tadu flag", () => {
		const { runner, calls } = capture();
		const c = taduControl(runner);
		c.move("TASK-1", "in-progress");
		// `--file=…` would otherwise read a file into the comment (arbitrary-file-read).
		c.comment("TASK-1", "--file=/home/tvd/.config/agent-toolkit/serve.env");
		expect(calls[0]).toEqual(["move", "--", "TASK-1", "in-progress"]);
		expect(calls[1]).toEqual(["comment", "--", "TASK-1", "--file=/home/tvd/.config/agent-toolkit/serve.env"]);
	});

	it("humanTaduControl uses the same separator", () => {
		const { runner, calls } = capture();
		humanTaduControl(runner).comment("TASK-2", "looks good");
		expect(calls[0]).toEqual(["comment", "--", "TASK-2", "looks good"]);
	});

	it("reports failure when the runner throws or returns non-zero", () => {
		const throwing = taduControl(() => {
			throw new Error("no tadu");
		});
		expect(throwing.move("TASK-1", "done")).toBe(false);
		const nonZero = taduControl(() => ({ status: 1, stdout: "", stderr: "err" }));
		expect(nonZero.comment("TASK-1", "x")).toBe(false);
	});
});
