/**
 * JSONL framing for the Pi RPC protocol.
 *
 * Pi's RPC mode uses strict JSONL with LF (`\n`) as the ONLY record delimiter
 * (docs/rpc.md §Framing). Generic line readers (including Node `readline`) are
 * non-compliant because they also split on U+2028/U+2029, which are valid,
 * unescaped characters inside JSON strings — splitting there corrupts frames.
 *
 * This framer therefore splits only on `\n`, strips an optional trailing `\r`,
 * and buffers partial lines across chunk boundaries. It is pure and decoupled
 * from JSON parsing so the (bug-prone) framing is tested in isolation.
 */

import { StringDecoder } from "node:string_decoder";

export class JsonlFramer {
	private buffer = "";
	private readonly decoder = new StringDecoder("utf8");

	/** Feed a chunk; return any complete lines it produced (CR-stripped, non-empty). */
	push(chunk: Buffer | string): string[] {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const lines: string[] = [];
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			let line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line !== "") lines.push(line);
			index = this.buffer.indexOf("\n");
		}
		return lines;
	}

	/** Flush any buffered trailing line on stream end. */
	flush(): string[] {
		this.buffer += this.decoder.end();
		const rest = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
		this.buffer = "";
		return rest !== "" ? [rest] : [];
	}
}

/** Encode a command object as a single LF-terminated JSON line. */
export function encodeCommand(command: unknown): string {
	return `${JSON.stringify(command)}\n`;
}

/** Parse one JSON line, returning undefined on malformed input rather than throwing. */
export function parseLine<T = unknown>(line: string): T | undefined {
	try {
		return JSON.parse(line) as T;
	} catch {
		return undefined;
	}
}
