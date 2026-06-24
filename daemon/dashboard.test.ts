import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDecision } from "../extensions/lib/decisions";
import { notify } from "../extensions/lib/notify";
import { Dashboard } from "./dashboard";

let dir: string;
let dash: Dashboard;
let port: number;
let enqueued: string[];

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "dash-"));
	process.env.AGENT_TOOLKIT_STATE_DIR = dir;
	enqueued = [];
	recordDecision({ kind: "trigger", summary: "did a thing" });
	notify({ summary: "needs you" }, { now: 1000 });
	writeFileSync(join(dir, "status.json"), JSON.stringify({ healthy: true, restarts: 0 }));
	dash = new Dashboard({
		enqueue: (t) => enqueued.push(t),
		statusPath: join(dir, "status.json"),
		cronJobs: () => [{ id: "heartbeat", schedule: "*/30 * * * *", description: "Heartbeat" }],
		port: 0,
	});
	port = await dash.start();
});

afterEach(async () => {
	await dash.stop();
	rmSync(dir, { recursive: true, force: true });
	delete process.env.AGENT_TOOLKIT_STATE_DIR;
});

const url = (p: string) => `http://127.0.0.1:${port}${p}`;

describe("Dashboard", () => {
	it("serves the HTML shell", async () => {
		const res = await fetch(url("/"));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Agent Toolkit");
	});

	it("exposes status, decisions, notices, and cron", async () => {
		const status = (await (await fetch(url("/api/status"))).json()) as any;
		expect(status.status.healthy).toBe(true);
		expect(status.counts.decisions).toBeGreaterThanOrEqual(2);

		const decisions = (await (await fetch(url("/api/decisions"))).json()) as any;
		expect(decisions.decisions.some((d: any) => d.summary === "did a thing")).toBe(true);

		const notices = (await (await fetch(url("/api/notices"))).json()) as any;
		expect(notices.notices.some((n: any) => n.summary === "needs you")).toBe(true);

		const cron = (await (await fetch(url("/api/cron"))).json()) as any;
		expect(cron.jobs[0].id).toBe("heartbeat");
	});

	it("queues a trigger and acks a notice via control endpoints", async () => {
		const t = await fetch(url("/api/trigger"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "from the browser" }),
		});
		expect(((await t.json()) as any).ok).toBe(true);
		expect(enqueued).toEqual(["from the browser"]);

		const notices = (await (await fetch(url("/api/notices"))).json()) as any;
		const id = notices.notices[0].id;
		const a = await fetch(url("/api/ack"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
		expect(((await a.json()) as any).ok).toBe(true);
	});
});

describe("Dashboard auth", () => {
	it("guards the API behind a bearer token when set", async () => {
		const dir2 = mkdtempSync(join(tmpdir(), "dash2-"));
		process.env.AGENT_TOOLKIT_STATE_DIR = dir2;
		const guarded = new Dashboard({ enqueue: () => {}, statusPath: join(dir2, "s.json"), token: "secret", port: 0 });
		const p = await guarded.start();
		try {
			expect((await fetch(`http://127.0.0.1:${p}/api/status`)).status).toBe(401);
			expect((await fetch(`http://127.0.0.1:${p}/api/status?token=secret`)).status).toBe(200);
			const withHeader = await fetch(`http://127.0.0.1:${p}/api/status`, { headers: { Authorization: "Bearer secret" } });
			expect(withHeader.status).toBe(200);
		} finally {
			await guarded.stop();
			rmSync(dir2, { recursive: true, force: true });
		}
	});
});
