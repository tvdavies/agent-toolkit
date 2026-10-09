// The "chapter" scene kind: a numbered product chapter. Text column (number, title, a point per bar) beside a
// stage holding the rebuilt app under a camera; on tall and square frames the column sits above the stage.
//   { kind: "chapter", bars: 4, n: 1, tag: "Agent", title: "Steer it<br><em>mid-run.</em>",
//     pts: [["Point on bar 0"], ["Point on bar 1", "optional sub-line"], ...],
//     app: (c) => html,            // inside a 1280×800 .app; or body: html for a chapter without the app
//     cam: (c) => [[t, x, y, scale], ...],   // app coordinates, scale for a 1100×800 stage (fitted to the real one)
//     init(el, c), render(t, el, c), foot: "Live now" }
// c.b(i, n) counts bars from the chapter's first bar, so a chapter can move in the plan without retiming.
(() => {
  const { $, $$, show } = MV;
  MV.kind("chapter", (o) => {
    const nn = String(o.n).padStart(2, "0");
    const el = MV.section(o, "ch", `${MV.head({ tag: `${o.tag} · ${nn}` }, false)}
      <div class="ch-col"><div class="ch-num">${nn}</div><h2>${o.title}</h2><div class="ch-pts">${(o.pts || []).map(([a, s]) => `<div class="ch-pt"><div>${a}${s ? `<small>${s}</small>` : ""}</div></div>`).join("")}</div></div>
      ${o.app ? `<div class="ch-stage" data-crop><div class="app"></div></div>` : `<div class="ch-body">${o.body || ""}</div>`}
      <div class="ch-foot"><span>lleverage.ai</span><span>${o.foot || "Live now"}</span></div>`);
    let cam = null;
    const local = (c) => ({ ...c, b: (i, n = 0) => MV.b(c.bar0 + i, n), bar: (i) => MV.bar(c.bar0 + i) });
    return {
      el,
      init(c) {
        const cc = local(c);
        if (o.app) {
          $(".app", el).innerHTML = o.app(cc);
          const stage = $(".ch-stage", el);
          // The stage is display:none until its scene shows; measure it from the layout instead.
          const vw = parseFloat(getComputedStyle(stage).width) || stage.offsetWidth, vh = parseFloat(getComputedStyle(stage).height) || stage.offsetHeight;
          // Camera scales are written for the landscape stage (1100 × 800 at 1920 wide); fit them to this stage so
          // one chapter works at every format and resolution.
          const k = Math.min(vw / 1100, vh / 800);
          const keys = (o.cam ? o.cam(cc) : [[0, 640, 400, 0.86]]).map(([t, x, y, s]) => [t, x, y, s * k]);
          cam = MV.camera($(".app", el), vw, vh, keys);
        }
        o.init && o.init(el, cc);
      },
      render(t, c) {
        const cc = local(c);
        show($("h2", el), t, c.a - 0.2, Infinity, 30, 0.3);
        $$(".ch-pt", el).forEach((d, i) => show(d, t, MV.bar(c.bar0 + (o.ptBars ? o.ptBars[i] : i)) - 0.06, Infinity, 24, 0.3));
        cam && cam(t);
        o.render && o.render(t, el, cc);
      },
    };
  });
})();
