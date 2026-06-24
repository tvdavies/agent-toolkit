import { describe, expect, it } from "bun:test";
import { encodeCommand, JsonlFramer, parseLine } from "./framing";

// Unicode line/paragraph separators, built via code points to avoid embedding
// raw separator characters in this source file.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe("JsonlFramer", () => {
	it("splits complete lines on LF", () => {
		const f = new JsonlFramer();
		expect(f.push("a\nb\nc\n")).toEqual(["a", "b", "c"]);
	});

	it("buffers partial lines across chunks", () => {
		const f = new JsonlFramer();
		expect(f.push("hel")).toEqual([]);
		expect(f.push("lo\nwor")).toEqual(["hello"]);
		expect(f.push("ld\n")).toEqual(["world"]);
	});

	it("strips a trailing CR (accepts CRLF input)", () => {
		const f = new JsonlFramer();
		expect(f.push("x\r\ny\r\n")).toEqual(["x", "y"]);
	});

	it("does NOT split on U+2028/U+2029 inside a JSON string", () => {
		const f = new JsonlFramer();
		const value = `line1${LS}line2${PS}line3`;
		const payload = JSON.stringify({ message: value });
		// Confirm JSON.stringify left the separators raw (the hazard this guards).
		expect(payload).toContain(LS);
		expect(payload).toContain(PS);
		const lines = f.push(`${payload}\n`);
		expect(lines).toHaveLength(1);
		expect(parseLine<{ message: string }>(lines[0] as string)?.message).toBe(value);
	});

	it("reconstructs a frame whose U+2028 lands on a chunk boundary", () => {
		const f = new JsonlFramer();
		const payload = JSON.stringify({ m: `a${LS}b` });
		const sep = payload.indexOf(LS);
		expect(f.push(payload.slice(0, sep))).toEqual([]);
		const lines = f.push(`${payload.slice(sep)}\n`);
		expect(parseLine<{ m: string }>(lines[0] as string)?.m).toBe(`a${LS}b`);
	});

	it("ignores empty lines", () => {
		const f = new JsonlFramer();
		expect(f.push("a\n\n\nb\n")).toEqual(["a", "b"]);
	});

	it("flush returns a buffered trailing line", () => {
		const f = new JsonlFramer();
		expect(f.push("partial")).toEqual([]);
		expect(f.flush()).toEqual(["partial"]);
		expect(f.flush()).toEqual([]);
	});
});

describe("encodeCommand / parseLine", () => {
	it("round-trips a command", () => {
		const line = encodeCommand({ type: "prompt", message: "hi" });
		expect(line.endsWith("\n")).toBe(true);
		expect(parseLine<{ type: string; message: string }>(line.trimEnd())).toEqual({
			type: "prompt",
			message: "hi",
		});
	});

	it("returns undefined for malformed JSON", () => {
		expect(parseLine("not json")).toBeUndefined();
	});
});
