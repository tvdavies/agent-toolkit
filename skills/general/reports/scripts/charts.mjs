// Static SVG charts in the reports house style. No dependencies, no runtime JS.
// Colours come from CSS classes defined in assets/report.css, so charts follow the theme.
//
// renderChart(spec) -> SVG string. See references/visuals.md for the spec format.

const W_DEFAULT = 720;
const COLOR_KEYS = new Set(["c1", "c2", "c3", "c4", "c5", "c6", "cm", "cbad", "cwarn", "cgood"]);
const ALIASES = { accent: "c1", muted: "cm", grey: "cm", gray: "cm", bad: "cbad", red: "cbad", warn: "cwarn", amber: "cwarn", good: "cgood", green: "cgood" };

export class ChartError extends Error {}

const esc = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r1 = (n) => Math.round(n * 10) / 10;
const textWidth = (text, px = 12.5) => String(text ?? "").length * px * 0.53;
// Value and tick labels are set in the monospace face, which is wider per character.
const monoWidth = (text, px = 11.5) => String(text ?? "").length * px * 0.62;

function colorClass(color, index) {
  if (color == null) return `c${(index % 6) + 1}`;
  const key = ALIASES[color] ?? color;
  if (!COLOR_KEYS.has(key)) throw new ChartError(`Unknown colour "${color}". Use c1–c6, accent, muted, bad, warn or good.`);
  return key;
}
const strokeClass = (fill) => `s${fill.slice(1)}`;

function makeFormatter(spec) {
  const decimals = spec.decimals;
  const unit = spec.unit ?? "";
  const prefix = spec.prefix ?? "";
  const nf = new Intl.NumberFormat("en-GB", decimals == null ? { maximumFractionDigits: 2 } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const spaced = unit && !["%", "×", "x", "k", "M"].includes(unit) ? ` ${unit}` : unit;
  return (value) => (value == null || Number.isNaN(value) ? "–" : `${prefix}${nf.format(value)}${spaced}`);
}

function niceStep(range, target) {
  const raw = range / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}
function niceScale(min, max, target = 5) {
  if (min === max) max = min + 1;
  const step = niceStep(max - min, target);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo, hi, ticks };
}

function num(value, where) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ChartError(`${where} must be a finite number (got ${JSON.stringify(value)}).`);
  return value;
}

function svgOpen(width, height, spec) {
  const label = spec.alt ?? spec.title ?? "Chart";
  return `<svg class="chart chart-${esc(spec.type)}" viewBox="0 0 ${width} ${r1(height)}" width="${width}" height="${r1(height)}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">`;
}

function legend(items, x, y, width) {
  // items: [{name, cls, kind: "box"|"line"}]; wraps to multiple rows.
  let cx = x;
  let cy = y;
  const parts = [];
  for (const item of items) {
    const w = 16 + textWidth(item.name, 12) + 22;
    if (cx + w > x + width && cx > x) { cx = x; cy += 20; }
    if (item.kind === "ref") parts.push(`<line x1="${cx}" y1="${cy - 4}" x2="${cx + 12}" y2="${cy - 4}" class="ref-line"/>`);
    else if (item.kind === "line") parts.push(`<line x1="${cx}" y1="${cy - 4}" x2="${cx + 12}" y2="${cy - 4}" class="line ${strokeClass(item.cls)}"/>`);
    else parts.push(`<rect x="${cx}" y="${cy - 10}" width="11" height="11" class="${item.cls}"/>`);
    parts.push(`<text x="${cx + 17}" y="${cy}" class="legend-label">${esc(item.name)}</text>`);
    cx += w;
  }
  return { svg: parts.join(""), height: cy - y + 20 };
}

// ---------- Horizontal bar ----------
function barChart(spec) {
  const data = spec.data;
  if (!Array.isArray(data) || data.length === 0) throw new ChartError("bar chart needs a non-empty data array.");
  const rows = data.map((d, i) => ({ ...d, value: num(d.value, `data[${i}].value`) }));
  if (spec.sort === "desc") rows.sort((a, b) => b.value - a.value);
  if (spec.sort === "asc") rows.sort((a, b) => a.value - b.value);
  const fmt = makeFormatter(spec);
  const width = spec.width ?? W_DEFAULT;
  const highlight = new Set(spec.highlight ?? []);
  const labelW = Math.min(spec.labelWidth ?? Math.max(...rows.map((d) => textWidth(d.label))) + 16, width * 0.42);
  const valueW = Math.max(...rows.map((d) => monoWidth(d.display ?? fmt(d.value)))) + 14;
  const rowH = spec.rowHeight ?? 30;
  const barH = Math.min(18, rowH - 10);
  const top = spec.reference ? 22 : 6;
  const plotX = labelW;
  const plotW = width - labelW - valueW;
  const maxV = spec.max ?? Math.max(...rows.map((d) => d.value), spec.reference?.value ?? 0);
  const minV = Math.min(0, ...rows.map((d) => d.value));
  const scale = (v) => plotX + ((v - minV) / (maxV - minV || 1)) * plotW;
  const parts = [];
  rows.forEach((d, i) => {
    const y = top + i * rowH;
    const cls = d.color ? colorClass(d.color, i) : highlight.size ? (highlight.has(d.label) ? "c1" : "cm") : "c1";
    const x0 = scale(Math.min(0, d.value));
    const x1 = scale(Math.max(0, d.value));
    parts.push(`<text x="${plotX - 12}" y="${r1(y + rowH / 2 + 4)}" text-anchor="end" class="cat-label">${esc(d.label)}</text>`);
    if (spec.track !== false) parts.push(`<rect x="${plotX}" y="${r1(y + (rowH - barH) / 2)}" width="${r1(plotW)}" height="${barH}" class="track"/>`);
    parts.push(`<rect x="${r1(x0)}" y="${r1(y + (rowH - barH) / 2)}" width="${r1(Math.max(1, x1 - x0))}" height="${barH}" class="${cls}"/>`);
    parts.push(`<text x="${r1(Math.max(x1, plotX + (spec.track !== false ? plotW : 0)) + 8)}" y="${r1(y + rowH / 2 + 4)}" class="value-label">${esc(d.display ?? fmt(d.value))}</text>`);
  });
  const height = top + rows.length * rowH + 4;
  if (spec.reference) parts.push(referenceV(spec.reference, scale, top - 4, height, fmt));
  return svgOpen(width, height, spec) + parts.join("") + "</svg>";
}

function referenceV(ref, scale, y0, y1, fmt) {
  const x = r1(scale(num(ref.value, "reference.value")));
  const label = ref.label ?? fmt(ref.value);
  return `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" class="ref-line"/><text x="${x + 5}" y="${y0 + 8}" class="ref-label">${esc(label)}</text>`;
}

// ---------- Horizontal stacked (absolute or percent) ----------
function stackedChart(spec) {
  const { categories, series } = spec;
  if (!Array.isArray(categories) || !Array.isArray(series) || series.length === 0) throw new ChartError("stacked chart needs categories and series.");
  const fmt = makeFormatter(spec.percent ? { ...spec, unit: "%", decimals: spec.decimals ?? 0 } : spec);
  const width = spec.width ?? W_DEFAULT;
  const labelW = categories.length === 1 && !categories[0] ? 0 : Math.min(Math.max(...categories.map((c) => textWidth(c))) + 16, width * 0.36);
  const totalsFmt = categories.map((_, ci) => fmt(series.reduce((sum, s) => sum + (Number(s.values[ci]) || 0), 0)));
  const totalW = spec.percent ? 0 : Math.max(...totalsFmt.map((t) => monoWidth(t))) + 14;
  const rowH = spec.rowHeight ?? 34;
  const barH = Math.min(22, rowH - 10);
  const leg = legend(series.map((s, i) => ({ name: s.name, cls: colorClass(s.color, i) })), labelW, 14, width - labelW);
  const top = leg.height + 8;
  const plotX = labelW;
  const plotW = width - labelW - totalW;
  const totals = categories.map((_, ci) => series.reduce((sum, s, si) => sum + (num(s.values[ci] ?? 0, `series[${si}].values[${ci}]`) ?? 0), 0));
  const maxTotal = spec.percent ? 100 : spec.max ?? Math.max(...totals);
  const parts = [leg.svg];
  categories.forEach((cat, ci) => {
    const y = top + ci * rowH;
    if (labelW) parts.push(`<text x="${plotX - 12}" y="${r1(y + rowH / 2 + 4)}" text-anchor="end" class="cat-label">${esc(cat)}</text>`);
    let acc = 0;
    series.forEach((s, si) => {
      const raw = s.values[ci] ?? 0;
      const v = spec.percent ? (totals[ci] ? (raw / totals[ci]) * 100 : 0) : raw;
      const x = plotX + (acc / maxTotal) * plotW;
      const w = (v / maxTotal) * plotW;
      const cls = colorClass(s.color, si);
      parts.push(`<rect x="${r1(x)}" y="${r1(y + (rowH - barH) / 2)}" width="${r1(Math.max(0, w - 1))}" height="${barH}" class="${cls}"/>`);
      const label = fmt(v);
      if (w > textWidth(label, 11.5) + 10 && spec.labels !== false) {
        parts.push(`<text x="${r1(x + w / 2)}" y="${r1(y + rowH / 2 + 4)}" text-anchor="middle" class="value-label ${cls === "cm" ? "" : "inside"}">${esc(label)}</text>`);
      }
      acc += v;
    });
    if (!spec.percent) parts.push(`<text x="${r1(plotX + (acc / maxTotal) * plotW + 8)}" y="${r1(y + rowH / 2 + 4)}" class="value-label">${esc(fmt(totals[ci]))}</text>`);
  });
  const height = top + categories.length * rowH + 4;
  return svgOpen(width, height, spec) + parts.join("") + "</svg>";
}

// ---------- Vertical columns (grouped or stacked) ----------
function columnChart(spec) {
  const { categories, series } = spec;
  if (!Array.isArray(categories) || !Array.isArray(series) || series.length === 0) throw new ChartError("column chart needs categories and series.");
  const fmt = makeFormatter(spec);
  const width = spec.width ?? W_DEFAULT;
  const height = spec.height ?? 300;
  const multi = series.length > 1;
  // The reference label goes in the legend row: inline it would collide with the columns.
  const legItems = multi ? series.map((s, i) => ({ name: s.name, cls: colorClass(s.color, i) })) : [];
  if (spec.reference) legItems.push({ name: spec.reference.label ?? fmt(spec.reference.value), kind: "ref" });
  const leg = legItems.length ? legend(legItems, 48, 14, width - 48) : { svg: "", height: 0 };
  const top = leg.height + 18;
  const bottom = 34;
  const values = series.flatMap((s, si) => s.values.map((v, ci) => num(v ?? 0, `series[${si}].values[${ci}]`)));
  const stackTotals = categories.map((_, ci) => series.reduce((sum, s) => sum + (s.values[ci] ?? 0), 0));
  const dataMax = spec.stacked ? Math.max(...stackTotals) : Math.max(...values);
  const sc = niceScale(Math.min(0, ...values), spec.max ?? Math.max(dataMax, spec.reference?.value ?? 0));
  const axisW = Math.max(...sc.ticks.map((t) => monoWidth(fmt(t), 11))) + 10;
  const plotX = axisW;
  const plotW = width - axisW - 4;
  const plotH = height - top - bottom;
  const y = (v) => top + plotH - ((v - sc.lo) / (sc.hi - sc.lo)) * plotH;
  const parts = [leg.svg];
  for (const t of sc.ticks) {
    parts.push(`<line x1="${plotX}" y1="${r1(y(t))}" x2="${width}" y2="${r1(y(t))}" class="${t === 0 ? "baseline" : "grid"}"/>`);
    parts.push(`<text x="${plotX - 8}" y="${r1(y(t) + 4)}" text-anchor="end" class="tick-label">${esc(fmt(t))}</text>`);
  }
  const groupW = plotW / categories.length;
  const inner = groupW * 0.72;
  const barW = spec.stacked ? inner : inner / series.length;
  const highlight = new Set(spec.highlight ?? []);
  categories.forEach((cat, ci) => {
    const gx = plotX + ci * groupW + (groupW - inner) / 2;
    let acc = 0;
    series.forEach((s, si) => {
      const v = s.values[ci] ?? 0;
      let cls = colorClass(s.color, si);
      if (!multi && highlight.size) cls = highlight.has(cat) ? "c1" : "cm";
      const x = spec.stacked ? gx : gx + si * barW;
      const y0 = spec.stacked ? y(acc + v) : y(Math.max(0, v));
      const y1 = spec.stacked ? y(acc) : y(Math.min(0, v));
      parts.push(`<rect x="${r1(x + 1)}" y="${r1(y0)}" width="${r1(Math.max(1, barW - 2))}" height="${r1(Math.max(0.5, y1 - y0))}" class="${cls}"/>`);
      if (!spec.stacked && spec.labels !== false && (series.length === 1 || barW > 26)) {
        parts.push(`<text x="${r1(x + barW / 2)}" y="${r1(y0 - 6)}" text-anchor="middle" class="value-label">${esc(fmt(v))}</text>`);
      }
      acc += v;
    });
    if (spec.stacked && spec.labels !== false) parts.push(`<text x="${r1(gx + inner / 2)}" y="${r1(y(acc) - 6)}" text-anchor="middle" class="value-label">${esc(fmt(acc))}</text>`);
    parts.push(`<text x="${r1(gx + inner / 2)}" y="${height - bottom + 18}" text-anchor="middle" class="tick-label">${esc(cat)}</text>`);
  });
  if (spec.reference) {
    const ry = r1(y(spec.reference.value));
    parts.push(`<line x1="${plotX}" y1="${ry}" x2="${width}" y2="${ry}" class="ref-line"/>`);
  }
  if (spec.yLabel) parts.push(`<text x="${plotX}" y="${top - 8}" class="axis-label">${esc(spec.yLabel)}</text>`);
  return svgOpen(width, height, spec) + parts.join("") + "</svg>";
}

// ---------- Line ----------
function lineChart(spec) {
  const { x, series } = spec;
  if (!Array.isArray(x) || !Array.isArray(series) || series.length === 0) throw new ChartError("line chart needs x and series.");
  const fmt = makeFormatter(spec);
  const width = spec.width ?? W_DEFAULT;
  const height = spec.height ?? 300;
  const values = series.flatMap((s, si) => s.values.map((v, i) => num(v, `series[${si}].values[${i}]`))).filter((v) => v != null);
  const sc = niceScale(spec.min ?? Math.min(0, ...values), spec.max ?? Math.max(...values, spec.reference?.value ?? -Infinity));
  const axisW = Math.max(...sc.ticks.map((t) => monoWidth(fmt(t), 11))) + 10;
  const endLabelW = series.length > 1 ? Math.max(...series.map((s) => textWidth(s.name, 12))) + 14 : 10;
  const top = 18;
  const bottom = 34;
  const plotX = axisW;
  const plotW = width - axisW - endLabelW;
  const plotH = height - top - bottom;
  const xs = (i) => plotX + (x.length === 1 ? plotW / 2 : (i / (x.length - 1)) * plotW);
  const ys = (v) => top + plotH - ((v - sc.lo) / (sc.hi - sc.lo)) * plotH;
  const parts = [];
  for (const t of sc.ticks) {
    parts.push(`<line x1="${plotX}" y1="${r1(ys(t))}" x2="${plotX + plotW}" y2="${r1(ys(t))}" class="${t === sc.lo ? "baseline" : "grid"}"/>`);
    parts.push(`<text x="${plotX - 8}" y="${r1(ys(t) + 4)}" text-anchor="end" class="tick-label">${esc(fmt(t))}</text>`);
  }
  const every = Math.max(1, Math.ceil(x.length / Math.floor(plotW / 64)));
  x.forEach((label, i) => {
    if (i % every === 0 || i === x.length - 1) parts.push(`<text x="${r1(xs(i))}" y="${height - bottom + 18}" text-anchor="middle" class="tick-label">${esc(label)}</text>`);
  });
  if (spec.reference) {
    const ry = r1(ys(spec.reference.value));
    parts.push(`<line x1="${plotX}" y1="${ry}" x2="${plotX + plotW}" y2="${ry}" class="ref-line"/><text x="${plotX + plotW}" y="${ry - 6}" text-anchor="end" class="ref-label">${esc(spec.reference.label ?? fmt(spec.reference.value))}</text>`);
  }
  for (const m of spec.markers ?? []) {
    const i = x.indexOf(m.x);
    if (i < 0) throw new ChartError(`marker x "${m.x}" is not in x.`);
    const mx = r1(xs(i));
    parts.push(`<line x1="${mx}" y1="${top}" x2="${mx}" y2="${top + plotH}" class="grid" stroke-dasharray="3 3"/><text x="${mx + 5}" y="${top + 10}" class="annotation">${esc(m.label)}</text>`);
  }
  const ends = [];
  series.forEach((s, si) => {
    const cls = colorClass(s.color, si);
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${r1(xs(i))},${r1(ys(v))}`;
      pen = true;
    });
    parts.push(`<path d="${d}" class="line ${strokeClass(cls)}"${s.dashed ? ' stroke-dasharray="5 4"' : ""}/>`);
    if (x.length <= 24 && spec.dots !== false) s.values.forEach((v, i) => { if (v != null) parts.push(`<circle cx="${r1(xs(i))}" cy="${r1(ys(v))}" r="3.2" class="dot ${cls}"/>`); });
    const lastIndex = s.values.map((v) => v != null).lastIndexOf(true);
    if (lastIndex >= 0) ends.push({ y: ys(s.values[lastIndex]), x: xs(lastIndex), name: s.name, value: s.values[lastIndex] });
  });
  if (series.length > 1) {
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    for (const e of ends) parts.push(`<text x="${r1(e.x + 8)}" y="${r1(e.y + 4)}" class="legend-label">${esc(e.name)}</text>`);
  } else if (ends[0] && spec.labels !== false) {
    parts.push(`<text x="${r1(ends[0].x)}" y="${r1(ends[0].y - 9)}" text-anchor="end" class="value-label">${esc(fmt(ends[0].value))}</text>`);
  }
  if (spec.yLabel) parts.push(`<text x="${plotX}" y="${top - 6}" class="axis-label">${esc(spec.yLabel)}</text>`);
  return svgOpen(width, height, spec) + parts.join("") + "</svg>";
}

// ---------- Range / distribution (e.g. latency p10–p90 with p50 and p99) ----------
function rangeChart(spec) {
  const data = spec.data;
  if (!Array.isArray(data) || data.length === 0) throw new ChartError("range chart needs a non-empty data array.");
  const keys = { low: "Low", mid: "Median", high: "High", max: "Max", ...(spec.names ?? {}) };
  const fmt = makeFormatter(spec);
  const width = spec.width ?? W_DEFAULT;
  const rows = data.map((d, i) => ({
    label: d.label,
    low: num(d.low, `data[${i}].low`),
    mid: d.mid == null ? null : num(d.mid, `data[${i}].mid`),
    high: num(d.high, `data[${i}].high`),
    max: d.max == null ? null : num(d.max, `data[${i}].max`),
    color: d.color,
  }));
  const labelW = Math.min(Math.max(...rows.map((d) => textWidth(d.label))) + 16, width * 0.36);
  const items = [{ name: `${keys.low}–${keys.high}`, cls: "c1" }];
  const leg = legend(items, labelW, 14, width - labelW);
  const legendExtra = [];
  let lx = labelW + 16 + textWidth(items[0].name, 12) + 22;
  if (rows.some((r) => r.mid != null)) { legendExtra.push(`<rect x="${r1(lx)}" y="4" width="3" height="12" fill="var(--ink)"/><text x="${r1(lx + 9)}" y="14" class="legend-label">${esc(keys.mid)}</text>`); lx += 9 + textWidth(keys.mid, 12) + 22; }
  if (rows.some((r) => r.max != null)) legendExtra.push(`<circle cx="${r1(lx + 4)}" cy="10" r="3.5" class="cbad"/><text x="${r1(lx + 12)}" y="14" class="legend-label">${esc(keys.max)}</text>`);
  const top = leg.height + 14;
  const rowH = spec.rowHeight ?? 32;
  const sc = niceScale(spec.min ?? 0, spec.max ?? Math.max(...rows.map((r) => r.max ?? r.high), spec.reference?.value ?? 0));
  // Tick labels are centred on their gridline, so leave room for half of the last one.
  const valueW = Math.max(12, monoWidth(fmt(sc.hi), 11) / 2 + 4);
  const plotX = labelW;
  const plotW = width - labelW - valueW;
  const xs = (v) => plotX + ((Math.min(v, sc.hi) - sc.lo) / (sc.hi - sc.lo)) * plotW;
  const parts = [leg.svg, ...legendExtra];
  const plotBottom = top + rows.length * rowH;
  for (const t of sc.ticks) {
    parts.push(`<line x1="${r1(xs(t))}" y1="${top}" x2="${r1(xs(t))}" y2="${plotBottom}" class="grid"/>`);
    parts.push(`<text x="${r1(xs(t))}" y="${plotBottom + 16}" text-anchor="middle" class="tick-label">${esc(fmt(t))}</text>`);
  }
  rows.forEach((d, i) => {
    const y = top + i * rowH + rowH / 2;
    const cls = colorClass(d.color ?? "c1", 0);
    parts.push(`<text x="${plotX - 12}" y="${r1(y + 4)}" text-anchor="end" class="cat-label">${esc(d.label)}</text>`);
    parts.push(`<rect x="${r1(xs(d.low))}" y="${r1(y - 6)}" width="${r1(Math.max(2, xs(d.high) - xs(d.low)))}" height="12" class="${cls}" opacity=".85"/>`);
    if (d.max != null) parts.push(`<line x1="${r1(xs(d.high))}" y1="${r1(y)}" x2="${r1(xs(d.max))}" y2="${r1(y)}" class="grid" stroke-dasharray="2 2"/><circle cx="${r1(xs(d.max))}" cy="${r1(y)}" r="3.5" class="cbad"/>`);
    if (d.mid != null) parts.push(`<rect x="${r1(xs(d.mid) - 1.5)}" y="${r1(y - 9)}" width="3" height="18" fill="var(--ink)"/>`);
  });
  if (spec.reference) parts.push(referenceV(spec.reference, xs, top - 6, plotBottom, fmt));
  const height = plotBottom + 26;
  return svgOpen(width, height, spec) + parts.join("") + "</svg>";
}

const RENDERERS = { bar: barChart, stacked: stackedChart, column: columnChart, line: lineChart, range: rangeChart };

export function renderChart(spec) {
  if (!spec || typeof spec !== "object") throw new ChartError("Chart spec must be a JSON object.");
  const renderer = RENDERERS[spec.type];
  if (!renderer) throw new ChartError(`Unknown chart type "${spec.type}". Use one of: ${Object.keys(RENDERERS).join(", ")}.`);
  return renderer(spec);
}

export const CHART_TYPES = Object.keys(RENDERERS);
