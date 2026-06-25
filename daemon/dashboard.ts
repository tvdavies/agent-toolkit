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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { countDecisions, readRecent } from "../extensions/lib/decisions.ts";
import { type Episode, episodeSummary, parseEpisodesFromJsonl } from "../extensions/lib/episodes.ts";
import { ackNotice, readNotices } from "../extensions/lib/notify.ts";
import { getTask, listTasks, readConfig, readEvents } from "../extensions/lib/tadu.ts";

export type DashboardOptions = {
	/** Queue a control trigger (e.g. "do X") from the browser. */
	enqueue: (text: string) => void;
	/** Answer a blocked worker's needs_human question (ref = task id or run id). */
	answer?: (ref: string, text: string) => void;
	/** Path to daemon-status.json. */
	statusPath: string;
	/** Current cron jobs (id/schedule/description), for the schedules panel. */
	cronJobs?: () => Array<{ id: string; schedule: string; description?: string }>;
	/** pi session directory, parsed into episodes for the Sessions tab. */
	sessionsDir?: string;
	/** Worker session directory; its episodes are tagged "worker". */
	workerSessionsDir?: string;
	/** Live worker-pool counts for the overview. */
	workerStats?: () => { active: number; queued: number };
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
						workers: this.o.workerStats?.() ?? { active: 0, queued: 0 },
					});
				case "/api/decisions":
					return this.json(res, 200, { decisions: readRecent(Number(url.searchParams.get("limit") ?? 50)) });
				case "/api/notices":
					return this.json(res, 200, { notices: readNotices().slice(-50).reverse() });
				case "/api/cron":
					return this.json(res, 200, { jobs: this.o.cronJobs?.() ?? [] });
				case "/api/episodes":
					return this.json(res, 200, { episodes: this.listEpisodes(Number(url.searchParams.get("limit") ?? 100)) });
				case "/api/episode":
					return this.json(res, 200, { episode: this.getEpisode(url.searchParams.get("id") ?? "") ?? null });
				case "/api/tasks": {
					const config = readConfig();
					return this.json(res, 200, { lanes: config.statuses, terminal: config.terminal, tasks: listTasks() });
				}
				case "/api/task": {
					const id = url.searchParams.get("id") ?? "";
					return this.json(res, 200, {
						task: getTask(id) ?? null,
						events: readEvents(500).filter((e) => e.task === id).slice(-30),
					});
				}
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
				if (path === "/api/answer" && typeof data.ref === "string" && data.ref.trim() && typeof data.text === "string" && data.text.trim()) {
					this.o.answer?.(data.ref.trim(), data.text.trim());
					if (typeof data.id === "string") ackNotice(data.id); // clear the escalation once answered
					return this.json(res, 200, { ok: true });
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

	/** Session directories to scan, with a tag and whether sessions are nested in
	 *  per-run subdirs (workers) vs flat files (the resident). */
	private episodeSources(): Array<{ dir: string; tag?: string; nested?: boolean }> {
		const sources: Array<{ dir: string; tag?: string; nested?: boolean }> = [];
		if (this.o.sessionsDir) sources.push({ dir: this.o.sessionsDir });
		if (this.o.workerSessionsDir) sources.push({ dir: this.o.workerSessionsDir, tag: "worker", nested: true });
		return sources;
	}

	/** Resolve a session dir to (file, sessionId) pairs. Worker dirs are nested one
	 *  level (per-run subdir = the run id, which is also the session id). */
	private sessionFiles(dir: string, nested?: boolean): Array<{ file: string; sessionId: string }> {
		const out: Array<{ file: string; sessionId: string }> = [];
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			return out;
		}
		if (!nested) {
			for (const f of entries) if (f.endsWith(".jsonl")) out.push({ file: join(dir, f), sessionId: f.replace(/\.jsonl$/, "") });
			return out;
		}
		for (const sub of entries) {
			const subdir = join(dir, sub);
			try {
				if (!statSync(subdir).isDirectory()) continue;
				const jsonl = readdirSync(subdir).find((f) => f.endsWith(".jsonl"));
				if (jsonl) out.push({ file: join(subdir, jsonl), sessionId: sub });
			} catch {
				// skip an unreadable run dir
			}
		}
		return out;
	}

	private listEpisodes(limit: number): ReturnType<typeof episodeSummary>[] {
		const out: ReturnType<typeof episodeSummary>[] = [];
		for (const { dir, tag, nested } of this.episodeSources()) {
			if (!existsSync(dir)) continue;
			for (const { file, sessionId } of this.sessionFiles(dir, nested)) {
				try {
					const eps = parseEpisodesFromJsonl(readFileSync(file, "utf8"), sessionId);
					for (const ep of eps) {
						const summary = episodeSummary(ep);
						out.push(tag ? { ...summary, source: tag } : summary);
					}
				} catch {
					// skip a corrupt session file
				}
			}
		}
		return out
			.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
			.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 100);
	}

	private getEpisode(id: string): Episode | undefined {
		const sessionId = id.split("#")[0];
		if (!sessionId) return undefined;
		for (const { dir, tag, nested } of this.episodeSources()) {
			if (!existsSync(dir)) continue;
			const match = this.sessionFiles(dir, nested).find((s) => s.sessionId === sessionId);
			if (!match) continue;
			try {
				const ep = parseEpisodesFromJsonl(readFileSync(match.file, "utf8"), sessionId).find((e) => e.id === id);
				if (ep) return tag ? { ...ep, source: tag } : ep;
			} catch {
				// try the next source
			}
		}
		return undefined;
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
  * { box-sizing: border-box; }
  body { font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; background: #0f1115; color: #d7dae0; }
  header { padding: 10px 18px; border-bottom: 1px solid #232733; display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 14px; margin: 0; color: #fff; }
  header .meta { color: #8b93a7; margin-left: auto; }
  nav button { background: none; border: 0; color: #8b93a7; font: inherit; cursor: pointer; padding: 6px 10px; border-radius: 6px; }
  nav button.active { color: #fff; background: #1a1d26; }
  main { padding: 14px 18px; }
  section { border: 1px solid #232733; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; min-width: 0; }
  section h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #8b93a7; margin: 0 0 8px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .row { padding: 4px 0; border-bottom: 1px solid #1a1d26; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .k { color: #7aa2f7; } .esc { color: #f7768e; } .ok { color: #9ece6a; } .muted { color: #8b93a7; }
  form { display: flex; gap: 8px; }
  input, select { background: #161922; border: 1px solid #232733; color: #d7dae0; border-radius: 6px; padding: 6px 8px; font: inherit; }
  input { flex: 1; }
  button.act { background: #2a3145; color: #d7dae0; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  .split { display: grid; grid-template-columns: 360px 1fr; gap: 12px; align-items: start; }
  .list .item { padding: 8px; border-bottom: 1px solid #1a1d26; cursor: pointer; }
  .list .item:hover { background: #161922; } .list .item.sel { background: #1a1d26; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 10px; background: #232733; color: #8b93a7; }
  .badge.hb { background: #2d2540; color: #c0a4f7; } .badge.err { background: #3a1f29; color: #f7768e; }
  .badge.wk { background: #16302a; color: #9ece6a; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 4px 0; background: #0c0e13; border: 1px solid #1a1d26; border-radius: 6px; padding: 8px; max-height: 320px; overflow: auto; }
  details { margin: 4px 0; } summary { cursor: pointer; color: #8b93a7; }
  .turn { border-left: 2px solid #232733; padding-left: 10px; margin: 8px 0; }
  .lanes { display: flex; gap: 10px; overflow-x: auto; }
  .lane { flex: 0 0 220px; } .lane h3 { font-size: 11px; color: #8b93a7; text-transform: uppercase; margin: 0 0 6px; }
  .card { background: #161922; border: 1px solid #232733; border-radius: 6px; padding: 7px 8px; margin-bottom: 6px; cursor: pointer; }
  .card:hover { border-color: #2a3145; } .card .id { color: #7aa2f7; font-size: 11px; }
  a.link { color: #7aa2f7; cursor: pointer; }
</style></head>
<body>
<header>
  <h1>Agent Toolkit</h1>
  <nav>
    <button id="tab-overview" class="active" onclick="show('overview')">Overview</button>
    <button id="tab-sessions" onclick="show('sessions')">Sessions</button>
    <button id="tab-board" onclick="show('board')">Board</button>
  </nav>
  <span class="meta" id="status">connecting…</span>
</header>
<main>
  <div id="view-overview">
    <section><h2>Steer</h2>
      <form id="trigger"><input id="text" placeholder="Queue a trigger for the agent…" autocomplete="off"><button class="act">Send</button></form>
    </section>
    <div class="grid2">
      <section><h2>Escalation inbox</h2><div id="notices"></div></section>
      <section><h2>Schedules</h2><div id="cron"></div></section>
    </div>
    <section><h2>Decisions (live)</h2><div id="decisions"></div></section>
  </div>

  <div id="view-sessions" style="display:none">
    <section>
      <h2>Sessions / episodes
        <select id="src" onchange="loadEpisodes()" style="margin-left:8px">
          <option value="">all sources</option><option value="heartbeat">heartbeat</option><option value="session">session</option><option value="worker">worker</option>
        </select>
        <span class="link" onclick="loadEpisodes()" style="margin-left:8px">↻</span>
      </h2>
      <div class="split">
        <div class="list" id="episodes"></div>
        <div id="transcript"><span class="muted">Select an episode to see the transcript.</span></div>
      </div>
    </section>
  </div>

  <div id="view-board" style="display:none">
    <section><h2>TADU board <span class="link" onclick="loadBoard()" style="margin-left:8px">↻</span></h2>
      <div class="lanes" id="lanes"></div>
    </section>
    <section id="task-detail" style="display:none"><h2>Task</h2><div id="task-body"></div></section>
  </div>
</main>
<script>
var token = location.hash.slice(1);
var auth = token ? { Authorization: "Bearer " + token } : {};
function q(p){ return p + (token ? (p.indexOf("?")>=0?"&":"?") + "token=" + encodeURIComponent(token) : ""); }
function api(p){ return fetch(q(p), { headers: auth }).then(function(r){ return r.json(); }); }
function esc(s){ return String(s==null?"":s).replace(/[&<>]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }); }
function clk(iso){ return iso ? esc(String(iso).slice(11,19)) : ""; }
function el(html){ var d=document.createElement("div"); d.innerHTML=html; return d.firstElementChild; }

function show(name){
  ["overview","sessions","board"].forEach(function(n){
    document.getElementById("view-"+n).style.display = n===name?"block":"none";
    document.getElementById("tab-"+n).classList.toggle("active", n===name);
  });
  if(name==="sessions") loadEpisodes();
  if(name==="board") loadBoard();
}

// ---- Overview ----
function row(html, cls){ var d=document.createElement("div"); d.className="row "+(cls||""); d.innerHTML=html; return d; }
function refresh(){
  api("/api/status").then(function(s){
    var st=s.status||{};
    var w=s.workers||{active:0,queued:0};
    document.getElementById("status").textContent=(st.healthy?"● running":"○ down")+" · "+w.active+" workers/"+w.queued+" queued · "+s.counts.decisions+" decisions · "+s.counts.notices+" unacked";
  }).catch(function(){ document.getElementById("status").textContent="error"; });
  api("/api/notices").then(function(n){
    var nb=document.getElementById("notices"); nb.innerHTML="";
    (n.notices||[]).filter(function(x){return !x.acked;}).slice(0,20).forEach(function(x){
      var d=row("<span class='esc'>!</span> "+esc(x.summary)+" ");
      var dt=x.detail||{};
      if(dt.needsHuman){
        // A blocked worker is waiting on YOU — answer it to resume that exact session.
        var ref=dt.taskId||dt.runId;
        var inp=document.createElement("input"); inp.placeholder="your answer for "+esc(ref)+"…"; inp.style.margin="4px 0";
        var ab=document.createElement("button"); ab.className="act"; ab.textContent="answer";
        ab.onclick=function(){
          if(!inp.value.trim()) return;
          fetch(q("/api/answer"),{method:"POST",headers:Object.assign({"content-type":"application/json"},auth),body:JSON.stringify({ref:ref,text:inp.value.trim(),id:x.id})}).then(refresh);
        };
        d.appendChild(inp); d.appendChild(ab);
      } else {
        var b=document.createElement("button"); b.className="act"; b.textContent="ack";
        b.onclick=function(){ fetch(q("/api/ack"),{method:"POST",headers:Object.assign({"content-type":"application/json"},auth),body:JSON.stringify({id:x.id})}).then(refresh); };
        d.appendChild(b);
      }
      nb.appendChild(d);
    });
    if(!nb.children.length) nb.appendChild(row("<span class='muted'>nothing needs you</span>"));
  });
  api("/api/cron").then(function(c){
    var cb=document.getElementById("cron"); cb.innerHTML="";
    (c.jobs||[]).forEach(function(j){ cb.appendChild(row("<span class='k'>"+esc(j.schedule)+"</span> "+esc(j.id)+" <span class='muted'>"+esc(j.description||"")+"</span>")); });
    if(!cb.children.length) cb.appendChild(row("<span class='muted'>no jobs</span>"));
  });
}
function addDecision(d){
  var box=document.getElementById("decisions");
  var cls=d.kind==="escalate"?"esc":"";
  box.prepend(row("<span class='muted'>"+clk(d.ts)+"</span> <span class='k "+cls+"'>"+esc(d.kind)+"</span> "+esc(d.summary), cls));
  while(box.children.length>80) box.removeChild(box.lastChild);
}

// ---- Sessions ----
function srcBadge(s){ var c=s==="heartbeat"?"hb":(s==="worker"?"wk":""); return "<span class='badge "+c+"'>"+esc(s)+"</span>"; }
function loadEpisodes(){
  var src=document.getElementById("src").value;
  api("/api/episodes?limit=200").then(function(r){
    var list=document.getElementById("episodes"); list.innerHTML="";
    (r.episodes||[]).filter(function(e){ return !src || e.source===src; }).forEach(function(e){
      var item=document.createElement("div"); item.className="item";
      var tools=e.toolCalls?(" · "+e.toolCalls+"🔧"):"";
      item.innerHTML=srcBadge(e.source)+" <span class='muted'>"+clk(e.startedAt)+"</span><br>"+esc((e.prompt||"").slice(0,70))+
        "<br><span class='muted'>"+esc(e.model||"")+tools+" · "+esc(e.outcome||"")+"</span>";
      item.onclick=function(){ Array.prototype.forEach.call(list.children,function(c){c.classList.remove("sel");}); item.classList.add("sel"); loadEpisode(e.id); };
      list.appendChild(item);
    });
    if(!list.children.length) list.innerHTML="<div class='muted' style='padding:8px'>no episodes yet</div>";
  });
}
function part(p){
  if(p.kind==="thinking") return "<details><summary>thinking</summary><pre class='muted'>"+esc(p.text)+"</pre></details>";
  if(p.kind==="text") return "<div>"+esc(p.text)+"</div>";
  if(p.kind==="toolCall") return "<div class='k'>▸ "+esc(p.name)+"</div><pre>"+esc(JSON.stringify(p.args,null,2))+"</pre>";
  if(p.kind==="toolResult") return "<pre class='"+(p.isError?"esc":"muted")+"'>"+esc((p.toolName?("["+p.toolName+"] "):"")+(p.text||"").slice(0,2000))+"</pre>";
  return "";
}
function loadEpisode(id){
  api("/api/episode?id="+encodeURIComponent(id)).then(function(r){
    var t=document.getElementById("transcript"); var e=r.episode;
    if(!e){ t.innerHTML="<span class='muted'>not found</span>"; return; }
    var usage=e.usage||{}; var cost=usage.cost!=null?(" · $"+usage.cost.toFixed(4)):"";
    var h="<div>"+srcBadge(e.source)+" <span class='muted'>"+clk(e.startedAt)+" → "+clk(e.endedAt)+" · "+esc(e.model||"")+
      " · "+(usage.input||0)+"in/"+(usage.output||0)+"out"+cost+" · "+esc(e.outcome||"")+"</span></div>";
    h+="<section><h2>prompt</h2><pre>"+esc(e.prompt)+"</pre></section>";
    (e.turns||[]).forEach(function(turn){
      h+="<div class='turn'>"+(turn.parts||[]).map(part).join("")+"</div>";
    });
    t.innerHTML=h;
  });
}

// ---- Board ----
function loadBoard(){
  api("/api/tasks").then(function(r){
    var lanes=document.getElementById("lanes"); lanes.innerHTML="";
    var byStatus={}; (r.tasks||[]).forEach(function(tk){ (byStatus[tk.status]=byStatus[tk.status]||[]).push(tk); });
    (r.lanes||[]).forEach(function(st){
      var lane=document.createElement("div"); lane.className="lane";
      lane.innerHTML="<h3>"+esc(st)+" <span class='muted'>"+((byStatus[st]||[]).length)+"</span></h3>";
      (byStatus[st]||[]).forEach(function(tk){
        var card=document.createElement("div"); card.className="card";
        var labels=(tk.labels||[]).map(function(l){return "<span class='badge'>"+esc(l)+"</span>";}).join(" ");
        card.innerHTML="<div class='id'>"+esc(tk.id)+"</div>"+esc(tk.title)+"<div>"+labels+"</div>";
        card.onclick=function(){ loadTask(tk.id); };
        lane.appendChild(card);
      });
      lanes.appendChild(lane);
    });
    if(!(r.tasks||[]).length) lanes.innerHTML="<div class='muted'>no tasks yet — triggers create them once a workspace exists</div>";
  });
}
function loadTask(id){
  api("/api/task?id="+encodeURIComponent(id)).then(function(r){
    var box=document.getElementById("task-detail"); var b=document.getElementById("task-body"); var tk=r.task;
    box.style.display="block";
    if(!tk){ b.innerHTML="<span class='muted'>not found</span>"; return; }
    var h="<div class='id k'>"+esc(tk.id)+" · "+esc(tk.status)+"</div><div style='font-size:14px;color:#fff;margin:4px 0'>"+esc(tk.title)+"</div>";
    if(tk.description) h+="<pre>"+esc(tk.description)+"</pre>";
    h+="<h2 style='margin-top:10px'>comments</h2>";
    (tk.comments||[]).forEach(function(c){ h+="<div class='row'><span class='muted'>"+clk(c.ts)+"</span> "+esc(c.text)+"</div>"; });
    if(!(tk.comments||[]).length) h+="<div class='muted'>no comments</div>";
    h+="<h2 style='margin-top:10px'>events</h2>";
    (r.events||[]).slice().reverse().forEach(function(ev){ h+="<div class='row'><span class='muted'>"+clk(ev.time)+"</span> "+esc(ev.type)+"</div>"; });
    b.innerHTML=h;
  });
}

// ---- init ----
function init(){
  api("/api/decisions?limit=40").then(function(d){ (d.decisions||[]).forEach(addDecision); });
  var ev=new EventSource(q("/events"));
  ev.onmessage=function(m){ try{ addDecision(JSON.parse(m.data)); }catch(e){} };
  document.getElementById("trigger").onsubmit=function(e){
    e.preventDefault(); var t=document.getElementById("text");
    if(!t.value.trim()) return;
    fetch(q("/api/trigger"),{method:"POST",headers:Object.assign({"content-type":"application/json"},auth),body:JSON.stringify({text:t.value.trim()})});
    t.value="";
  };
  refresh(); setInterval(refresh, 5000);
}
init();
</script>
</body></html>`;
