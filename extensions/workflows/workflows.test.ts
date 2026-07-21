import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { belongsToSession, buildFleetStateNoteFor, listPersistedRuns, pruneExpiredRuns, runBaseDir, runStorageDirs, describeRunLine, extractMeta, inFlightRunsOf, reportsPendingOf, transitionRunStatus, type RunState, validateScript, workflowModeGuidance, workflowOutputSpent, workflowRetryGuidance, workflowSourceRequiresApproval } from "./index.ts";
import { freshAgentSessionPath, renderSessionTail } from "./runner.ts";

function makeRun(over: Partial<RunState> = {}): RunState {
	return {
		id: "run-a",
		name: "audit",
		workflowPath: "/tmp/wf.ts",
		scope: "user",
		hash: "h",
		cwd: "/tmp",
		args: "",
		status: "running",
		startedAt: Date.now() - 65_000,
		phases: [],
		agents: [],
		runDir: "/tmp/run-a",
		...over,
	} as RunState;
}

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "wf-test-"));
}

describe("workflows — fleet state (pending-run awareness)", () => {
	test("session ownership fails closed when the current identity is unavailable", () => {
		expect(belongsToSession(makeRun({ ownerSession: "/sessions/a.jsonl" }), undefined)).toBe(false);
		expect(belongsToSession(makeRun({ ownerSession: "/sessions/a.jsonl" }), "/sessions/b.jsonl")).toBe(false);
		expect(belongsToSession(makeRun({ ownerSession: "/sessions/a.jsonl" }), "/sessions/a.jsonl")).toBe(true);
		expect(belongsToSession(makeRun({ ownerSession: undefined }), undefined)).toBe(true);
	});

	test("inFlightRunsOf keeps only running/pending and honours excludeId", () => {
		const runs = [
			makeRun({ id: "a", status: "running" }),
			makeRun({ id: "b", status: "pending" }),
			makeRun({ id: "c", status: "succeeded" }),
			makeRun({ id: "d", status: "failed" }),
			makeRun({ id: "e", status: "cancelled" }),
		];
		expect(inFlightRunsOf(runs).map((r) => r.id)).toEqual(["a", "b"]);
		expect(inFlightRunsOf(runs, "a").map((r) => r.id)).toEqual(["b"]);
	});

	test("all reports in -> explicit safe-to-finalise note", () => {
		const note = buildFleetStateNoteFor([makeRun({ id: "done", status: "succeeded" })], "done");
		expect(note).toContain("no other workflow executions or undelivered reports remain");
		expect(note).toContain("safe to synthesise");
	});

	test("completing run is excluded so the LAST completion reads as all-in", () => {
		// Terminal status is set before the message is sent, but excludeId must also guard
		// against the completing run still being flagged active in edge orderings.
		const note = buildFleetStateNoteFor([makeRun({ id: "last", status: "running" })], "last");
		expect(note).toContain("no other workflow executions or undelivered reports remain");
	});

	test("terminal runs with pending outboxes still block finalisation", () => {
		const pendingDelivery = makeRun({ id: "terminal-pending", status: "succeeded", deliveryStatus: "pending" });
		expect(reportsPendingOf([pendingDelivery]).map((run) => run.id)).toEqual(["terminal-pending"]);
		const note = buildFleetStateNoteFor([makeRun({ id: "done", status: "succeeded" }), pendingDelivery], "done");
		expect(note).toContain("terminal-pending");
		expect(note).toContain("NOT YET DELIVERED");
	});

	test("other active runs -> do-not-finalise warning listing each run", () => {
		const other = makeRun({
			id: "other-run",
			name: "security-sweep",
			status: "running",
			currentPhase: "verify",
			agents: [
				{ id: "agent-0001", label: "a1", agent: "scout", status: "succeeded", startedAt: 0, endedAt: 1 },
				{ id: "agent-0002", label: "a2", agent: "scout", status: "running", startedAt: 0 },
			],
		});
		const note = buildFleetStateNoteFor([makeRun({ id: "done", status: "succeeded" }), other], "done");
		expect(note).toContain("1 other workflow report(s) you launched are NOT YET DELIVERED");
		expect(note).toContain("security-sweep (other-run)");
		expect(note).toContain("phase verify");
		expect(note).toContain("agents 1/2 done");
		expect(note).toContain("Do NOT produce a final answer");
	});

	test("describeRunLine summarises status, phase, agent progress", () => {
		const line = describeRunLine(makeRun({ id: "x", name: "wf", status: "pending" }));
		expect(line).toContain("wf (x): pending");
		expect(line).toContain("agents 0/0 done");
	});
});

describe("workflows — terminal state authority", () => {
	test("terminal runs cannot transition back to success or another terminal state", () => {
		const run = makeRun({ status: "running" });
		transitionRunStatus(run, "cancelled");
		expect(run.status).toBe("cancelled");
		expect(() => transitionRunStatus(run, "succeeded")).toThrow("Illegal workflow transition");
	});

	test("pending and running follow only legal transitions", () => {
		const run = makeRun({ status: "pending" });
		transitionRunStatus(run, "running");
		transitionRunStatus(run, "timed_out");
		expect(run.status).toBe("timed_out");
	});
});

describe("workflows — launch approval policy", () => {
	test("agent-authored and user-saved workflow sources run autonomously", () => {
		expect(workflowSourceRequiresApproval("user")).toBe(false);
	});

	test("repository-provided workflow sources retain approval", () => {
		expect(workflowSourceRequiresApproval("project")).toBe(true);
	});
});

describe("workflows — standing orchestration mode", () => {
	test("workflow mode ON is an unhedged orchestrate-by-default directive", () => {
		const guidance = workflowModeGuidance(true);
		expect(guidance).toContain("workflow by DEFAULT");
		expect(guidance).toContain("wall-clock");
		expect(guidance).toContain("ONE bounded deliverable");
		// The gate lives at the mode toggle; the ON directive must not hedge with fan-out
		// quotas or escalation framing that reads the same as the OFF default.
		expect(guidance).not.toContain("ESCALATION");
		expect(guidance).not.toContain("at most two agents");
	});

	test("disabled mode recommends one direct subagent for one specialist", () => {
		expect(workflowModeGuidance(false)).toContain("Use one direct subagent instead");
	});
});

describe("workflows — output budget and retry semantics", () => {
	test("budget spending counts child output only", () => {
		const run = makeRun({
			budgetTotal: 10_000,
			budgetBaselineOutput: 9_999_999,
			agents: [
				{ id: "a", label: "a", agent: "scout", status: "succeeded", startedAt: 0, usage: { input: 50_000, output: 700, cacheRead: 100_000, cacheWrite: 0, cost: 1, turns: 2 } },
				{ id: "b", label: "b", agent: "reviewer", status: "succeeded", startedAt: 0, usage: { input: 80_000, output: 300, cacheRead: 200_000, cacheWrite: 0, cost: 2, turns: 3 } },
			] as any,
		});
		expect(workflowOutputSpent(run)).toBe(1_000);
	});

	test("deterministic failures stop whole-workflow retries", () => {
		expect(workflowRetryGuidance("Resource limit exceeded for reviewer")).toContain("Do not relaunch the whole workflow");
		expect(workflowRetryGuidance('Model "anthropic/foo" not found')).toContain("deterministic");
	});

	test("transient failures permit one child retry only", () => {
		const guidance = workflowRetryGuidance("provider overloaded with HTTP 503");
		expect(guidance).toContain("failed child, at most once");
		expect(guidance).toContain("do not relaunch the whole workflow");
	});
});

describe("workflows — script validation", () => {
	const VALID = `export const meta = { name: "t", description: "d", phases: [{ title: "p" }] };\nphase("p");\nconst out = await agent("do a thing");\nreturn String(out);\n`;

	test("accepts a minimal valid script", () => {
		expect(validateScript(VALID)).toEqual([]);
	});

	test("rejects imports, process, Date.now, and missing meta", () => {
		expect(validateScript(`import fs from "node:fs";\n${VALID}`).join("\n")).toContain("must not import");
		expect(validateScript(VALID.replace('await agent("do a thing")', "process.env.HOME")).join("\n")).toContain("Forbidden pattern");
		expect(validateScript(`${VALID}\nconst t = Date.now();`).join("\n")).toContain("Forbidden pattern");
		expect(validateScript(`return 1;`).join("\n")).toContain("export const meta");
	});

	test("forbidden words inside prompt STRINGS do not trip validation", () => {
		const script = `export const meta = { name: "t", description: "d" };\nreturn agent("kill the process using Date.now() and import fs");\n`;
		expect(validateScript(script)).toEqual([]);
	});

	test("extractMeta parses the literal and rejects non-literals", () => {
		expect(extractMeta(VALID)).toEqual({ name: "t", description: "d", phases: [{ title: "p" }] });
		expect(() => extractMeta(`export const meta = makeMeta();\nreturn 1;`)).toThrow();
	});
});

describe("workflows — session transcript tail (output-so-far)", () => {
	function writeSession(lines: unknown[]): string {
		const file = path.join(tmpDir(), "child.session.jsonl");
		fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
		return file;
	}

	const assistant = (content: unknown[]) => ({ type: "message", message: { role: "assistant", content } });

	test("renders assistant text and tool-call one-liners, skipping noise", () => {
		const file = writeSession([
			{ type: "session", version: 3 },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Task: do it" }] } },
			assistant([
				{ type: "thinking", thinking: "hidden reasoning" },
				{ type: "text", text: "starting the scan" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "rg -n TODO" } },
			]),
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "noisy tool result" }] } },
			assistant([{ type: "text", text: "found 3 TODOs" }]),
		]);
		const tail = renderSessionTail(file);
		expect(tail).toContain("starting the scan");
		expect(tail).toContain('→ bash {"command":"rg -n TODO"}');
		expect(tail).toContain("found 3 TODOs");
		expect(tail).not.toContain("hidden reasoning");
		expect(tail).not.toContain("noisy tool result");
		expect(tail).not.toContain("Task: do it");
	});

	test("caps at maxLines with an omitted-lines marker", () => {
		const file = writeSession([assistant([{ type: "text", text: "one\ntwo\nthree\nfour" }])]);
		const tail = renderSessionTail(file, 2);
		expect(tail).toContain("[… 2 earlier transcript line(s) omitted]");
		expect(tail).toContain("three\nfour");
		expect(tail).not.toContain("one\ntwo");
	});

	test("handles missing files, empty transcripts, and malformed lines", () => {
		expect(renderSessionTail(path.join(tmpDir(), "nope.jsonl"))).toBe("(no transcript yet)");
		const userOnly = writeSession([{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }]);
		expect(renderSessionTail(userOnly)).toBe("(transcript exists but contains no assistant output yet)");
		const mixed = path.join(tmpDir(), "mixed.jsonl");
		fs.writeFileSync(mixed, `not json at all\n${JSON.stringify(assistant([{ type: "text", text: "still works" }]))}\n`, "utf8");
		expect(renderSessionTail(mixed)).toBe("still works");
	});
});

describe("workflows — fresh session paths", () => {
	test("creates the agents dir and never reuses an existing session file", () => {
		const runDir = tmpDir();
		const first = freshAgentSessionPath(runDir, "scan");
		expect(first).toBe(path.join(runDir, "agents", "scan.session.jsonl"));
		fs.writeFileSync(first, "", "utf8");
		const second = freshAgentSessionPath(runDir, "scan");
		expect(second).toBe(path.join(runDir, "agents", "scan-2.session.jsonl"));
		fs.writeFileSync(second, "", "utf8");
		expect(freshAgentSessionPath(runDir, "scan")).toBe(path.join(runDir, "agents", "scan-3.session.jsonl"));
	});
});

describe("workflows — run storage location and retention", () => {
	function gitRepo(): string {
		const root = tmpDir();
		fs.mkdirSync(path.join(root, ".git"));
		return root;
	}

	function writeRun(base: string, over: Partial<RunState>): RunState {
		const state = makeRun({ ...over, runDir: path.join(base, over.id ?? "run-a") });
		fs.mkdirSync(state.runDir, { recursive: true });
		fs.writeFileSync(path.join(state.runDir, "state.json"), JSON.stringify(state), "utf8");
		return state;
	}

	test("new runs are stored under the home directory, never inside the project tree", () => {
		const root = gitRepo();
		const base = runBaseDir(root);
		expect(base.startsWith(root)).toBe(false);
		expect(base.startsWith(path.join(os.homedir(), ".pi", "agent", "workflow-runs"))).toBe(true);
		expect(runStorageDirs(root)).toContain(path.join(root, ".pi", "workflow-runs"));
	});

	test("legacy in-repo runs remain listed alongside home-dir runs", () => {
		const root = gitRepo();
		const legacyBase = path.join(root, ".pi", "workflow-runs");
		writeRun(legacyBase, { id: "legacy-run", status: "succeeded" });
		const listed = listPersistedRuns(root);
		expect(listed.map((run) => run.id)).toContain("legacy-run");
	});

	test("prunes delivered terminal runs past retention but keeps live and undelivered ones", async () => {
		const root = gitRepo();
		const legacyBase = path.join(root, ".pi", "workflow-runs");
		const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
		const expired = writeRun(legacyBase, { id: "expired", status: "succeeded", startedAt: old, endedAt: old, deliveryStatus: "sent_unacknowledged" });
		const undelivered = writeRun(legacyBase, { id: "undelivered", status: "succeeded", startedAt: old, endedAt: old, deliveryStatus: "pending" });
		const live = writeRun(legacyBase, { id: "live", status: "running", startedAt: old });
		const recent = writeRun(legacyBase, { id: "recent", status: "succeeded", endedAt: Date.now(), deliveryStatus: "sent_unacknowledged" });
		await pruneExpiredRuns(root);
		expect(fs.existsSync(expired.runDir)).toBe(false);
		expect(fs.existsSync(undelivered.runDir)).toBe(true);
		expect(fs.existsSync(live.runDir)).toBe(true);
		expect(fs.existsSync(recent.runDir)).toBe(true);
	});
});
