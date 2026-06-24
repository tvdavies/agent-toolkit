import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupe, FileInbox, type Trigger } from "./inbox";

describe("dedupe", () => {
	it("drops triggers already seen by dedupeKey, else id", () => {
		const seen = new Set<string>();
		const a: Trigger = { id: "1", text: "a" };
		const b: Trigger = { id: "2", text: "b", dedupeKey: "k" };
		const bAgain: Trigger = { id: "3", text: "b2", dedupeKey: "k" };
		expect(dedupe([a, b, bAgain], seen).map((t) => t.id)).toEqual(["1", "2"]);
		expect(dedupe([a, b], seen)).toEqual([]);
	});
});

describe("FileInbox", () => {
	let dir: string;
	let inbox: FileInbox;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "inbox-"));
		inbox = new FileInbox(join(dir, "inbox.jsonl"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("appends with generated id/ts and drains once", () => {
		const t = inbox.append({ text: "do a thing", source: "cli" });
		expect(t.id).toBeTruthy();
		expect(t.ts).toBeTruthy();
		const drained = inbox.drain();
		expect(drained).toHaveLength(1);
		expect(drained[0]?.text).toBe("do a thing");
		expect(drained[0]?.source).toBe("cli");
	});

	it("does not redeliver drained triggers", () => {
		inbox.append({ text: "one" });
		inbox.append({ text: "two" });
		expect(inbox.drain().map((t) => t.text)).toEqual(["one", "two"]);
		expect(inbox.drain()).toEqual([]);
		inbox.append({ text: "three" });
		expect(inbox.drain().map((t) => t.text)).toEqual(["three"]);
	});

	it("survives a new instance via the persisted cursor", () => {
		inbox.append({ text: "one" });
		inbox.drain();
		const reopened = new FileInbox(join(dir, "inbox.jsonl"));
		reopened.append({ text: "two" });
		expect(reopened.drain().map((t) => t.text)).toEqual(["two"]);
	});

	it("returns empty for a never-written inbox", () => {
		expect(new FileInbox(join(dir, "missing.jsonl")).drain()).toEqual([]);
	});
});
