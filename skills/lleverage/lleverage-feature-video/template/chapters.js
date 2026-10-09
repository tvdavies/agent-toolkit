// Product chapters for the plan. Each returns a "chapter" item (ui/chapter.js); times use c.b(bar, beat) and
// c.bar(i), counted from the chapter's own first bar, so chapters can be reordered without retiming.
// These are the chapters of the 2–9 October 2026 week video: copy one as the starting point for a new feature.
// Data is illustrative (Dutch and German supplier names, SAP-style PO numbers); never a real customer.
const CHAPTERS = (() => {
  const { $, p, pop } = MV;

  // Mid-run steering: a message sent while the agent works waits for its next step, then joins the turn.
  const steer = (o = {}) => ({ kind: "chapter", bars: 4, tag: "Agent", title: "Steer it<br><em>mid-run.</em>",
    pts: [["Send a message while the agent works."], ["It waits for the agent's next step."], ["The running turn picks it up."], ["The run carries on. No restart."]],
    app: () => UI.chat("st",
      UI.user("st-u1", "Process the order confirmations in Demo/Inputs and summarise each one.") +
      UI.assistant("st-a1", UI.step("st-s1", "faFileLines", "Listed Demo/Inputs (3 files)") + UI.step("st-s2", "faFileLines", "Read OC-88213_Kessler_Antriebstechnik.pdf") + UI.step("st-s3", "faFileLines", "Read AB-2026-0917_Rheinland_Antriebstechnik.pdf")) +
      UI.user("st-u2", "Also flag any line over €10,000.") +
      UI.assistant("st-a2", UI.step("st-s4", "faMagnifyingGlass", "Checked line totals against €10,000") + `<div id="st-a2t"></div>`),
      { extra: UI.pending("st-pend", ["Also flag any line over €10,000."]) }),
    cam: (c) => [[c.bar(0), 760, 520, 1.25], [c.b(0, 1), 760, 520, 1.25], [c.b(0, 1.6), 760, 590, 1.6], [c.bar(2) - 0.1, 760, 590, 1.6], [c.bar(2) + 0.4, 760, 520, 1.45], [c.bar(4), 760, 520, 1.45]],
    render(t, el, c) {
      UI.typeInto($("#st-ta"), "Also flag any line over €10,000.", t, c.b(0, 1.8), c.b(0, 3.6), c.bar(1));
      pop($("#st-pend"), t, c.bar(1), 10); if (t >= c.bar(2)) $("#st-pend").style.display = "none";
      pop($("#st-s3"), t, c.b(1, 2)); pop($("#st-u2"), t, c.bar(2)); pop($("#st-a2"), t, c.b(2, 2));
      MV.type($("#st-a2t"), "Noted. Two lines are over €10,000: 4500012877/20 at €12,480.00 and 4500012881/10 at €18,960.00. I'll mark both in the summaries.", t, c.bar(3), c.b(3, 3));
      UI.setStatus($("#st-status"), t < c.bar(2) ? "Using a tool" : t < c.bar(3) ? "Thinking" : "Responding", 14 + Math.floor(t - c.bar(0)), t);
    }, ...o });

  // The agent builds a workflow on the canvas: nodes land on beats, a Branch splices in, a decision on one route.
  const workflow = (o = {}) => ({ kind: "chapter", bars: 4, tag: "Workflows", title: "Agent-built<br><em>workflows.</em>",
    pts: [["The agent drafts the workflow."], ["It splices a Branch into the line."], ["Adds a decision on one route."], ["And sees what each trigger receives."]],
    app: () => `${UI.sidebar("Workflows", "Document intake")}<main class="panel"><div class="ph"><h1>Supplier order confirmations</h1><div class="right"><span class="pill ready">Draft</span></div></div>
      <div class="canvas"><svg class="edges"><path id="e1"/><path id="e2"/><path id="e3"/><path id="e4" stroke-dasharray="4 4"/></svg>
      ${UI.node("n1", 20, 250, { icon: UI.integration("microsoft-outlook"), color: "node-plum", ref: "confirmationEmail", desc: "A supplier emails an order confirmation" })}
      ${UI.node("n2", 250, 250, { icon: fa("s:faRobot"), color: "node-coral", ref: "agent", desc: "Read the confirmation and compare it with the PO" })}
      ${UI.node("n3", 480, 250, { icon: fa("s:faCodeBranch"), color: "node-sky", ref: "branch", desc: "Does anything need a buyer's check?" })}
      ${UI.node("n4", 700, 100, { icon: fa("s:faUserCheck"), color: "node-mauve", ref: "buyerDecision", desc: "Ask the buyer to accept the changes" })}
      <div class="evt" id="evt" style="left:20px;top:370px"><span class="k">"from"</span>: "orders@kessler-antrieb.de",
<span class="k">"subject"</span>: "Auftragsbestätigung 88213",
<span class="k">"receivedAt"</span>: "2026-10-09T08:14:00Z",
<span class="k">"attachments"</span>: [ "OC-88213.pdf" ]</div></div></main>`,
    cam: (c) => [[c.bar(0), 600, 330, 1.25], [c.bar(1) - 0.2, 600, 330, 1.25], [c.bar(1) + 0.3, 720, 320, 1.25], [c.bar(3) - 0.1, 720, 320, 1.25], [c.bar(3) + 0.35, 560, 420, 1.35], [c.bar(4), 560, 420, 1.35]],
    init() {
      UI.edges([["e1", "n1", "n2"], ["e2", "n2", "n3"], ["e3", "n3", "n4"]]);
      const n3 = $("#n3"), x = n3.offsetLeft + n3.offsetWidth, y = n3.offsetTop + 30;
      $("#e4").setAttribute("d", `M${x},${y} C${x + 70},${y} ${x + 120},${y + 150} ${x + 210},${y + 150}`);
    },
    render(t, el, c) {
      UI.nodeIn("n1", t, c.bar(0)); UI.nodeIn("n2", t, c.b(0, 1)); UI.edgeIn("e1", t, c.b(0, 1.5));
      UI.nodeIn("n3", t, c.bar(1)); UI.edgeIn("e2", t, c.b(1, 0.5));
      UI.nodeIn("n4", t, c.bar(2)); UI.edgeIn("e3", t, c.b(2, 0.5));
      $("#e4").style.opacity = MV.out(p(t, c.b(2, 1), c.b(2, 1.4)));
      MV.show($("#evt"), t, c.bar(3), Infinity, 14, 0.3);
    }, ...o });

  // Files: up to 50 per message, the limit toast, refused PDFs retried as text, output files as downloads.
  const FILES = ["OC-88213_Kessler_Antriebstechnik.pdf", "AB-2026-0917_Rheinland.pdf", "OC-77120_DeVries_Metaal.pdf", "OC-45001_Bakker_Hydrauliek.pdf", "Bestelling_4500012877.pdf",
    "OC-90214_Jansen_Lagers.pdf", "AB-2026-1003_Hoekstra.pdf", "OC-33418_Visser_Pompen.pdf", "OC-88240_Kessler.pdf", "PO-4500012881.pdf"];
  const files = (o = {}) => ({ kind: "chapter", bars: 4, tag: "Agent", title: "Files in,<br><em>files out.</em>",
    pts: [["Up to 50 files in one message."], ["Over the limit, it says why."], ["A refused PDF is retried as text."], ["Workflow output files come back as downloads."]],
    app: () => UI.chat("fl",
      UI.user("fl-u1", "Summarise these confirmations and save one PDF per supplier.") +
      UI.assistant("fl-a1", UI.step("fl-s1", "faFileLines", "Read 10 attachments") + UI.step("fl-s2", "faBolt", "Ran Process Supplier Order Confirmation") +
        `<div id="fl-a1t"></div><div class="atts" id="fl-out" style="padding:10px 0 0">${UI.attachment("88213_summary.pdf")}${UI.attachment("0917_summary.pdf")}</div>`),
      { overlay: UI.limitToast("fl-toast", 3) }),
    cam: (c) => [[c.bar(0), 760, 560, 1.3], [c.bar(1) - 0.1, 760, 560, 1.3], [c.bar(1) + 0.3, 900, 600, 1.3], [c.bar(2) - 0.1, 900, 600, 1.3], [c.bar(2) + 0.35, 760, 520, 1.4], [c.bar(4), 760, 520, 1.4]],
    init() { $("#fl-atts").innerHTML = FILES.map((f, i) => UI.attachment(f, "pdf", "fa" + i)).join(""); },
    render(t, el, c) {
      const sent = t >= c.bar(2);
      FILES.forEach((_, i) => { const a = c.b(0, Math.floor(i / 2.6)), d = $("#fa" + i); pop(d, t, a, 0, 0.2); if (sent) d.style.display = "none"; });
      $("#fl-ta").textContent = sent ? "Ask the agent anything…" : "Summarise these confirmations and save one PDF per supplier.";
      $("#fl-ta").className = sent ? "" : "typed";
      const q = MV.out(p(t, c.bar(1), c.bar(1) + 0.3)) * (1 - p(t, c.bar(2) - 0.25, c.bar(2)));
      $("#fl-toast").style.opacity = q; $("#fl-toast").style.transform = `translateY(${(1 - q) * 20}px)`;
      pop($("#fl-u1"), t, c.bar(2)); pop($("#fl-a1"), t, c.b(2, 1)); pop($("#fl-s2"), t, c.b(2, 2.5));
      MV.type($("#fl-a1t"), "Done. Two summaries are saved to Project Files in Demo/Summaries:", t, c.bar(3), c.b(3, 1.5));
      pop($("#fl-out"), t, c.b(3, 2));
      UI.setStatus($("#fl-status"), t < c.bar(2) ? null : t < c.bar(3) ? "Using a tool" : "Done", 3 + Math.floor(Math.max(0, t - c.bar(2))), t);
    }, ...o });

  // Sub-agents: three helpers, cards that stay live after the turn ends, partial work at the step budget.
  const subagents = (o = {}) => ({ kind: "chapter", bars: 4, tag: "Agent", title: "Sub-agents<br><em>by role.</em>",
    pts: [["Delegate by role.", "Explore, plan, general-purpose, fork."], ["Read-only helpers get read-only actions."], ["Cards stay live after the turn ends."], ["Out of steps? It returns its partial work."]],
    app: () => UI.chat("sub", UI.user("sub-u1", "Check every open confirmation against its purchase order.") +
      UI.assistant("sub-a1", `<div>I'll split this across three helpers.</div>${UI.subagent("sa1", "Find every order confirmation in Project Files")}${UI.subagent("sa2", "Match Kessler and Rheinland lines to their POs")}${UI.subagent("sa3", "Check DeVries prices against the 2026 price list",
        "Reached its step budget after 18 of 24 lines. Partial result: 3 price changes found (lines 4, 9 and 17). Lines 19–24 not checked.")}<div id="sub-t" style="margin-top:12px"></div>`)),
    cam: (c) => [[c.bar(0), 760, 500, 1.45], [c.bar(3) - 0.1, 760, 500, 1.45], [c.bar(3) + 0.35, 760, 520, 1.5], [c.bar(4), 760, 520, 1.5]],
    render(t, el, c) {
      [["sa1", c.b(0, 1), c.bar(1)], ["sa2", c.b(0, 2), c.b(1, 2)], ["sa3", c.b(0, 3), c.bar(3)]].forEach(([id, a, done]) => { pop($("#" + id), t, a); UI.subagentState(id, t, done, id === "sa3" && t >= c.b(3, 0.5)); });
      MV.type($("#sub-t"), "Kessler and Rheinland match their POs. DeVries is still being checked; its card will update here.", t, c.b(1, 2), c.bar(2));
      UI.setStatus($("#sub-status"), t < c.bar(2) ? "Using a tool" : "Done", 21 + Math.floor(Math.min(t, c.bar(2)) - c.bar(0)), t);
    }, ...o });

  // Faster first loads: each page's client rounds collapse into one server round on its beat.
  const ROWS = [["Project shell", "Prefetched on the server"], ["Workflows list", "No client access round"], ["Workflow cards", "Icons and avatars: one call each"],
    ["Requests inbox", "Saved views prefetched"], ["Activity", "View and filters loaded on the server"], ["Agent chat", "Loads on first open of the sidebar"]];
  const speed = (o = {}) => ({ kind: "chapter", bars: 4, tag: "Performance", title: "Faster<br><em>first loads.</em>",
    pts: [["Data starts loading on the server."], ["Fewer rounds before the page shows."], ["A first-load JS budget on every PR."], ["Web vitals from production."]],
    body: `<div class="wf"><div class="hdr"><span>Page</span><span>Requests before it shows</span></div>
      ${ROWS.map(([a, s], i) => `<div class="r" id="wr${i}"><div><b>${a}</b><small>${s}</small></div><div class="track"><span class="seg c">client</span><span class="seg c">client</span><span class="seg srv">server</span><span class="done">one round</span></div></div>`).join("")}</div>
      <div class="chips"><div class="chip" id="ch1"><small>PR CI</small>First-load JS budget, nightly ratchet</div><div class="chip" id="ch2"><small>Production</small>LCP, INP and CLS with attribution</div></div>`,
    render(t, el, c) {
      ROWS.forEach((_, i) => {
        const a = c.b(0, 2 * i), z = a + window.BEATS.period, r = $("#wr" + i, el), k = 1 - MV.out5(p(t, z, z + 0.25));
        MV.show(r, t, a - 0.2, Infinity, 0, 0.2);
        r.querySelectorAll(".seg.c").forEach((s) => { s.style.width = 140 * k + "px"; s.style.opacity = k; s.style.marginRight = (k > 0.02 ? 0 : -6) + "px"; });
        r.querySelector(".srv").style.width = MV.lerp(140, 200, 1 - k) + "px";
        r.querySelector(".done").style.opacity = MV.out(p(t, z + 0.1, z + 0.35));
      });
      MV.show($("#ch1", el), t, c.bar(2), Infinity, 30, 0.25); MV.show($("#ch2", el), t, c.bar(3), Infinity, 30, 0.25);
    }, ...o });

  // Workflow apps: Edit and resubmit, with the confirmation dialog; the earlier response stays.
  const card = (id, status, date) => UI.responseCard(id, { title: "Supplier order confirmation", status, by: "Tom Davies",
    fields: [["Confirmation number", "AB-2026-0917"], ["Delivery date", date], ["Accept the price change", "Yes"]] });
  const apps = (o = {}) => ({ kind: "chapter", bars: 3, tag: "Workflow apps", title: "Workflow<br><em>apps.</em>",
    pts: [["Edit an answer and resubmit."], ["The earlier response stays as it was."], ["Test runs keep their history after the tab closes."]],
    app: () => `<main class="panel both"><div class="wa">${card("r1", ["passed", "Submitted"], "14 November 2026")}<div id="r2w">${card("r2", ["running", "New response"], "21 November 2026")}</div></div>
      ${UI.resubmitDialog("dlg", "Supplier order confirmation")}</main>`,
    cam: (c) => [[c.bar(0), 640, 290, 1.3], [c.bar(3), 640, 290, 1.3]],
    init(el, c) { this.cur = MV.cursor($(".ch-stage", el), [[c.b(0, 1), 980, 760], [c.b(0, 2.6), $("#r1-btn")], [c.b(0, 3), $("#r1-btn"), true], [c.b(1, 2.4), $("#dlg-ok")], [c.b(1, 3), $("#dlg-ok"), true], [c.b(2, 1), 1060, 780]], c.cam); },
    render(t, el, c) {
      this.cur(t);
      const q = MV.out(p(t, c.b(0, 3.1), c.b(0, 3.4))) * (1 - p(t, c.b(1, 3.1), c.b(1, 3.3)));
      $("#dlg").style.opacity = $("#dlg-bd").style.opacity = q;
      pop($("#r2w"), t, c.b(1, 3.3), 20);
    }, ...o });

  return { steer, workflow, files, subagents, speed, apps };
})();
