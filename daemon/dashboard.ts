/**
 * Dashboard — a small read-mostly oversight UI served on loopback.
 *
 * It is a thin reader over the decision spine (the source of truth): recent
 * decisions, the escalation inbox (notify.jsonl), schedules, and daemon health;
 * plus minimal control (queue a trigger, ack a notice) and an SSE live tail.
 * The principle from the plan: oversight scales with autonomy by making every
 * decision a queryable line — the dashboard is a thin view over that, not the
 * product.
 *
 * Binds 127.0.0.1. An optional bearer token guards the API for tunnelled setups.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { countDecisions, readRecent } from "../extensions/lib/decisions.ts";
import { ackNotice, readNotices } from "../extensions/lib/notify.ts";

export type DashboardOptions = {
	/** Queue a control trigger (e.g. "do X") from the browser. */
	enqueue: (text: string) => void;
	/** Path to daemon-status.json. */
	statusPath: string;
	/** Current cron jobs (id/schedule/description), for the schedules panel. */
	cronJobs?: () => Array<{ id: string; schedule: string; description?: string }>;
	token?: string;
	host?: string;
	port?: number;
	logger?: (message: string) => void;
};

export class Dashboard {
	private server: Server | undefined;
	private readonly o: DashboardOptions;

	constructor(options: DashboardOptions) {
		this.o = options;
	}

	start(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => this.handle(req, res));
			server.on("error", reject);
			server.listen(this.o.port ?? 8788, this.o.host ?? "127.0.0.1", () => {
				const address = server.address();
				const port = typeof address === "object" && address ? address.port : (this.o.port ?? 0);
				this.o.logger?.(`[dashboard] http://${this.o.host ?? "127.0.0.1"}:${port}`);
				resolve(port);
			});
			this.server = server;
		});
	}

	stop(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
			this.server = undefined;
		});
	}

	get port(): number | undefined {
		const address = this.server?.address();
		return typeof address === "object" && address ? address.port : undefined;
	}

	private authorised(url: URL, req: IncomingMessage): boolean {
		if (!this.o.token) return true;
		const header = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
		return header === this.o.token || url.searchParams.get("token") === this.o.token;
	}

	private handle(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;

		if (path === "/" || path === "/index.html") {
			res.setHeader("content-type", "text/html; charset=utf-8");
			res.end(HTML);
			return;
		}

		if ((path.startsWith("/api/") || path === "/events") && !this.authorised(url, req)) {
			return this.json(res, 401, { error: "unauthorised" });
		}

		if (path === "/events") return this.sse(res);

		if (req.method === "GET") {
			switch (path) {
				case "/api/status":
					return this.json(res, 200, {
						status: readJson(this.o.statusPath),
						counts: { decisions: countDecisions(), notices: readNotices({ unackedOnly: true }).length },
					});
				case "/api/decisions":
					return this.json(res, 200, { decisions: readRecent(Number(url.searchParams.get("limit") ?? 50)) });
				case "/api/notices":
					return this.json(res, 200, { notices: readNotices().slice(-50).reverse() });
				case "/api/cron":
					return this.json(res, 200, { jobs: this.o.cronJobs?.() ?? [] });
			}
		}

		if (req.method === "POST") {
			return this.readBody(req, (body) => {
				const data = parseJson(body) ?? {};
				if (path === "/api/trigger" && typeof data.text === "string" && data.text.trim()) {
					this.o.enqueue(data.text.trim());
					return this.json(res, 200, { ok: true });
				}
				if (path === "/api/ack" && typeof data.id === "string") {
					return this.json(res, 200, { ok: ackNotice(data.id) });
				}
				return this.json(res, 400, { error: "bad request" });
			});
		}

		this.json(res, 404, { error: "not found" });
	}

	private sse(res: ServerResponse): void {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		let cursor = countDecisions();
		const timer = setInterval(() => {
			const total = countDecisions();
			if (total > cursor) {
				const fresh = readRecent(total - cursor);
				cursor = total;
				for (const d of fresh) res.write(`data: ${JSON.stringify(d)}\n\n`);
			} else {
				res.write(": keep-alive\n\n");
			}
		}, 1000);
		res.on("close", () => clearInterval(timer));
	}

	private json(res: ServerResponse, status: number, body: unknown): void {
		res.statusCode = status;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(body));
	}

	private readBody(req: IncomingMessage, done: (body: string) => void): void {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
	}
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function parseJson(body: string): any {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

const HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Toolkit</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; background: #0f1115; color: #d7dae0; }
  header { padding: 12px 20px; border-bottom: 1px solid #232733; display: flex; gap: 16px; align-items: baseline; }
  header h1 { font-size: 15px; margin: 0; color: #fff; }
  header .meta { color: #8b93a7; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px 20px; }
  section { border: 1px solid #232733; border-radius: 8px; padding: 12px 14px; min-width: 0; }
  section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #8b93a7; margin: 0 0 10px; }
  .row { padding: 4px 0; border-bottom: 1px solid #1a1d26; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .k { color: #7aa2f7; } .esc { color: #f7768e; } .muted { color: #8b93a7; }
  form { display: flex; gap: 8px; margin-top: 8px; }
  input { flex: 1; background: #161922; border: 1px solid #232733; color: #d7dae0; border-radius: 6px; padding: 6px 8px; }
  button { background: #2a3145; color: #d7dae0; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  .full { grid-column: 1 / -1; }
</style></head>
<body>
<header><h1>Agent Toolkit</h1><span class="meta" id="status">connecting…</span></header>
<main>
  <section class="full"><h2>Steer</h2>
    <form id="trigger"><input id="text" placeholder="Queue a trigger for the agent…" autocomplete="off"><button>Send</button></form>
  </section>
  <section><h2>Escalation inbox</h2><div id="notices"></div></section>
  <section><h2>Schedules</h2><div id="cron"></div></section>
  <section class="full"><h2>Decisions (live)</h2><div id="decisions"></div></section>
</main>
<script>
const token = location.hash.slice(1);
const auth = token ? { Authorization: "Bearer " + token } : {};
const q = (p) => p + (token ? (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token) : "");
async function getJSON(p){ const r = await fetch(q(p), { headers: auth }); return r.json(); }
function row(html, cls){ const d=document.createElement("div"); d.className="row "+(cls||""); d.innerHTML=html; return d; }
function esc(s){ return (s||"").replace(/[&<>]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
async function refresh(){
  try {
    const s = await getJSON("/api/status");
    const st = s.status || {};
    document.getElementById("status").textContent =
      (st.healthy ? "● running" : "○ down") + " · " + s.counts.decisions + " decisions · " + s.counts.notices + " unacked";
    const n = await getJSON("/api/notices");
    const nb = document.getElementById("notices"); nb.innerHTML="";
    (n.notices||[]).filter(x=>!x.acked).slice(0,20).forEach(x=>{
      const d=row("<span class='esc'>!</span> "+esc(x.summary)+" ");
      const b=document.createElement("button"); b.textContent="ack";
      b.onclick=async()=>{ await fetch(q("/api/ack"),{method:"POST",headers:{...auth,"content-type":"application/json"},body:JSON.stringify({id:x.id})}); refresh(); };
      d.appendChild(b); nb.appendChild(d);
    });
    if(!nb.children.length) nb.appendChild(row("<span class='muted'>nothing needs you</span>"));
    const c = await getJSON("/api/cron");
    const cb=document.getElementById("cron"); cb.innerHTML="";
    (c.jobs||[]).forEach(j=>cb.appendChild(row("<span class='k'>"+esc(j.schedule)+"</span> "+esc(j.id)+" <span class='muted'>"+esc(j.description||"")+"</span>")));
    if(!cb.children.length) cb.appendChild(row("<span class='muted'>no jobs</span>"));
  } catch(e){ document.getElementById("status").textContent="error"; }
}
function addDecision(d){
  const box=document.getElementById("decisions");
  const cls = d.kind==="escalate" ? "esc" : "";
  box.prepend(row("<span class='muted'>"+esc((d.ts||"").slice(11,19))+"</span> <span class='k "+cls+"'>"+esc(d.kind)+"</span> "+esc(d.summary), cls));
  while(box.children.length>100) box.removeChild(box.lastChild);
}
async function init(){
  const d = await getJSON("/api/decisions?limit=40");
  (d.decisions||[]).forEach(addDecision);
  const ev = new EventSource(q("/events"));
  ev.onmessage = (m)=>{ try{ addDecision(JSON.parse(m.data)); }catch{} };
  document.getElementById("trigger").onsubmit = async (e)=>{
    e.preventDefault(); const t=document.getElementById("text");
    if(!t.value.trim()) return;
    await fetch(q("/api/trigger"),{method:"POST",headers:{...auth,"content-type":"application/json"},body:JSON.stringify({text:t.value.trim()})});
    t.value="";
  };
  refresh(); setInterval(refresh, 5000);
}
init();
</script>
</body></html>`;
