// Lleverage product UI as HTML builders, for camera shots inside a chapter stage. Each builder names the
// component it mirrors (apps/app/src/components/...) and uses its real labels; references/components.md lists
// the exact copy. Icons come from icons.js (generated from your lleverage checkout by icons.mjs): fa("faName"),
// fa("s:faName") for solid, lu("name") for lucide.
const UI = (() => {
  // LleverageLoader (lleverage-loader.tsx): the 7×7 mark; drive() animates it for a mode at time t.
  const MARK = [".-----.", "-##-##-", "-#-#-#-", "--###--", "-#-#-#-", "-##-##-", ".-----."];
  const cells = [];
  MARK.forEach((row, r) => [...row].forEach((ch, c) => { if (ch !== ".") cells.push({ r, c, on: ch === "#", dist: Math.max(Math.abs(r - 3), Math.abs(c - 3)), ang: Math.atan2(r - 3, c - 3) }); }));
  const loader = (size = 18) => `<svg class="loader" width="${size}" height="${size}" viewBox="0 0 42 42" shape-rendering="crispEdges">${cells.map((k, i) =>
    `<rect class="off" x="${k.c * 6 + 1}" y="${k.r * 6 + 0.5}" width="4" height="5"/>` + (k.on ? `<rect class="on" data-i="${i}" x="${k.c * 6 + 1}" y="${k.r * 6 + 0.5}" width="4" height="5"/>` : "")).join("")}</svg>`;
  function drive(el, mode, t) {
    el.querySelectorAll("rect.on").forEach((r) => {
      const k = cells[+r.dataset.i], wave = (x, per) => 0.5 + 0.5 * Math.cos((2 * Math.PI * x) / per);
      let o = 1;
      if (mode === "working") o = 0.2 + 0.8 * Math.pow(Math.max(0, Math.cos(k.ang - (2 * Math.PI * t) / 1.4)), 3);
      else if (mode === "agent") o = k.dist <= 1 ? 1 : 0.3 + 0.7 * wave(t - ((k.ang + Math.PI) / (2 * Math.PI)) * 0.9, 0.9);
      else if (mode === "listening") o = 0.75 + 0.25 * wave(t, 3);
      r.style.opacity = o;
    });
  }

  // Shell: sidebar-nav.tsx with the default pins. active = the pinned item to highlight.
  function sidebar(active = "Agent", project = "Order intake") {
    const pins = [["Agent", "agent"], ["Overview", "faHouse"], ["Requests", "faInbox", 4], ["Workflows", "faBolt"], ["Skills", "faStar"], ["Data tables", "faFileSpreadsheet"], ["Monitoring", "faChartLine"]];
    const more = [["Knowledge", "faBookOpen"], ["Apps", "faPaperPlane"]];
    const item = ([label, icon, badge]) => `<div class="nav${label === active ? " on" : ""}"><span class="ib">${icon === "agent" ? loader(14) : fa(icon)}</span><span>${label}</span>${badge ? `<span class="badge-n">${badge}</span>` : ""}</div>`;
    return `<aside class="sb"><div class="sb-top"><div class="sb-logo"><img src="brand/logo/ident-dark.svg" style="width:20px;height:20px" alt=""></div>
      <div class="sb-proj">${project} ${fa("faChevronDown")}</div></div>
      <div class="sb-body"><div class="sb-label">Pinned</div>${pins.map(item).join("")}<div class="sb-label" style="margin-top:8px">Project</div>${more.map(item).join("")}</div></aside>`;
  }

  // Agent chat (agent-chat.tsx): user bubble, assistant prose with tool steps, status line, composer.
  const user = (id, text) => `<div class="msg user" id="${id}"><div class="ub">${text}</div></div>`;
  const assistant = (id, inner) => `<div class="msg" id="${id}"><div class="prose">${inner}</div></div>`;
  const step = (id, icon, text) => `<div class="step" id="${id}"><span class="dot">${fa(icon)}</span><span class="txt">${text}</span></div>`;
  // agent-status-indicator.tsx: "Stand by" | "Thinking" | "Using a tool" | "Responding" | "Waiting for you" | "Done".
  const status = (label, secs, stop = label !== "Done") => `<span>${loader(18)}</span><span>${label}</span><span class="el">· ${secs}s</span>${stop ? `<span class="stop">· <u>Stop</u></span>` : ""}`;
  const composer = (id, model = "Opus 5.5") => `<div class="composer" id="${id}-comp"><div class="atts" id="${id}-atts"></div><div class="ta"><div id="${id}-ta">Ask the agent anything…</div></div>
    <div class="row"><span class="rb">${fa("faPlus")}</span><div class="r"><span class="model">${model} ${fa("faChevronDown")}</span><span class="rb">${fa("faMicrophone")}</span><span class="send" id="${id}-send">${fa("s:faArrowUp")}</span></div></div></div>`;
  // The agent page: sidebar + centred chat. extra sits between the status line and the composer (e.g. pending()).
  const chat = (id, msgs, { extra = "", overlay = "", project = "Document intake" } = {}) => `${sidebar("Agent", project)}<main class="panel"><div class="chat">
      <div class="msgs" id="${id}-msgs">${msgs}</div><div class="status" id="${id}-status"></div>${extra}${composer(id)}</div>${overlay}</main>`;
  // Set the status line for time t (cheap: rebuilds only when the text changes).
  function setStatus(el, label, secs, t) {
    if (!label) { el.innerHTML = ""; el.dataset.k = ""; return; }
    const k = label + secs;
    if (el.dataset.k !== k) { el.innerHTML = status(label, secs); el.dataset.k = k; }
    el.className = "status" + (label === "Done" ? " done" : "");
    drive(el, "working", t);
  }
  // Typing into the composer between times a and z; after `sent` the placeholder returns.
  function typeInto(el, text, t, a, z, sent = Infinity) {
    const n = Math.round(text.length * MV.p(t, a, z));
    const live = t < sent && n > 0;
    el.className = live ? "typed" : "";
    el.innerHTML = live ? text.slice(0, n) + (n < text.length ? '<span class="caret"></span>' : "") : "Ask the agent anything…";
  }
  // queued-messages-list.tsx with steering on.
  const pending = (id, rows) => `<div class="pending" id="${id}"><div class="hd">${rows.length === 1 ? "1 message" : rows.length + " messages"} waiting for the agent's next step</div>
    ${rows.map((r) => `<div class="row"><span class="tx">${r}</span><span class="ic">${lu("arrowUp")}</span><span class="ic">${lu("x")}</span></div>`).join("")}</div>`;
  // composer-attachment-cards.tsx: a 128px card with the file name and a type pill.
  const attachment = (name, type = name.split(".").pop(), id = "") => `<div class="att"${id ? ` id="${id}"` : ""}>${name}<span class="ty">${type}</span></div>`;
  // The per-message limit toast (agent-chat.tsx; copy from packages/data/src/agent-message-attachments.ts).
  const limitToast = (id, n) => `<div class="toast" id="${id}"><b>${n === 1 ? "1 attachment wasn't added" : n + " attachments weren't added"}</b><span>You can add up to 50 files to one message. Remove some, or send the rest in a follow-up message.</span></div>`;
  // subagent-activity-card.tsx. The card shows the task, not the role; say the role in a caption.
  const subagent = (id, task, result = "") => `<div class="sa" id="${id}"><div class="h"><span class="bot">${lu("bot")}</span><span class="st" id="${id}-st"></span><span class="d">${task}</span><span class="chev">${lu("chevronRight")}</span></div>
    <div class="body" id="${id}-b" style="display:none"><div><div class="lb">Assigned task</div><div class="blk">${task}</div></div><div><div class="lb">Result</div><div class="blk">${result}</div></div></div></div>`;
  // Status icon of a sub-agent card at time t: working (spinning) until doneAt, then completed.
  function subagentState(id, t, doneAt, open = false) {
    const el = document.getElementById(id + "-st"), done = t >= doneAt;
    if (el.dataset.d !== String(done)) { el.innerHTML = fa(done ? "s:faCircleCheck" : "s:faCircleNotch"); el.className = "st" + (done ? " ok" : ""); el.dataset.d = done; }
    el.style.transform = done ? "" : `rotate(${(t * 360) % 360}deg)`;
    document.getElementById(id + "-b").style.display = open ? "" : "none";
    document.querySelector(`#${id} .chev`).style.transform = open ? "rotate(90deg)" : "";
  }

  // Canvas node (basic-node.tsx). icon: html (fa(...) or an <img>), color: a --node-* token, ref: the ref pill.
  // Real names and colours: Agent = s:faRobot / node-coral; Branch = s:faCodeBranch / node-sky;
  // Request Decision = s:faUserCheck / node-mauve; triggers = node-plum (integrations show their logo image).
  const node = (id, x, y, { icon, color, ref, desc }) => `<div class="node" id="${id}" style="left:${x}px;top:${y}px"><div class="nh">
      <span class="refpill"><span class="nic" style="background:hsl(var(--${color}))">${icon}</span>${ref}</span><div class="desc">${desc}</div></div>
      <span class="handle tgt"></span><span class="handle src"></span></div>`;
  // Edges: call after layout. pairs: [[edgeId, fromNodeId, toNodeId], ...]; paths must exist in an <svg class="edges">.
  function edges(pairs) {
    const h = (id, src) => { const el = document.getElementById(id); return [el.offsetLeft + (src ? el.offsetWidth : 0), el.offsetTop + 30]; };
    for (const [e, a, b] of pairs) {
      const [sx, sy] = h(a, true), [tx, ty] = h(b, false), path = document.getElementById(e);
      path.setAttribute("d", `M${sx},${sy} C${sx + 70},${sy} ${tx - 70},${ty} ${tx},${ty}`);
      const l = path.getTotalLength(); path.style.strokeDasharray = l; path.dataset.l = l;
    }
  }
  // A node landing at a (selected for a beat), and an edge drawing in.
  function nodeIn(id, t, a) {
    const el = document.getElementById(id), q = MV.back(MV.p(t, a, a + 0.3));
    el.style.opacity = MV.out(MV.p(t, a, a + 0.2)); el.style.transform = `scale(${t < a ? 0.8 : MV.lerp(0.8, 1, q)})`;
    el.classList.toggle("sel", t >= a && t < a + 1.2);
  }
  function edgeIn(id, t, a) { const el = document.getElementById(id); el.style.strokeDashoffset = +el.dataset.l * (1 - MV.io(MV.p(t, a, a + 0.35))); }

  // An integration's logo, as the app shows it in a node icon (copied from apps/app/public by icons.mjs).
  const integration = (slug) => `<img src="integrations/${slug}.png" alt="">`;

  // Workflow app response card with the "Edit and resubmit" strip, and the confirmation dialog.
  const responseCard = (id, { title, status = ["passed", "Submitted"], fields, by }) => `<div class="rcard" id="${id}"><div class="top">${title} <span class="pill ${status[0]}">${status[1]}</span></div>
      <dl>${fields.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      <div class="strip"><span>Answered by ${by}</span><span class="btn out" id="${id}-btn">${fa("faPenToSquare")}Edit and resubmit</span></div></div>`;
  const resubmitDialog = (id, title) => `<div class="backdrop" id="${id}-bd"></div><div class="dlg" id="${id}"><h4>Edit and resubmit “${title}”?</h4>
      <p>This creates a new response prefilled with your latest answers. Your earlier response stays in the session as it is.</p>
      <div class="acts"><span class="btn out">Cancel</span><span class="btn pri" id="${id}-ok">Create new response</span></div></div>`;

  return { integration, loader, drive, sidebar, user, assistant, step, status, setStatus, composer, chat, typeInto, pending, attachment, limitToast, subagent, subagentState, node, edges, nodeIn, edgeIn, responseCard, resubmitDialog };
})();
