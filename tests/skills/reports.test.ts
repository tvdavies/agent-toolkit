import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";

const root = path.resolve(import.meta.dir, "../..");
const skillDir = path.join(root, "skills/general/reports");
const { buildReport } = await import(path.join(skillDir, "scripts/build-report.mjs"));
const { renderChart, CHART_TYPES } = await import(path.join(skillDir, "scripts/charts.mjs"));

function source(body: string, front = "title: Test report\ndate: 2026-10-01") {
  const dir = mkdtempSync(path.join(tmpdir(), "reports-test-"));
  const file = path.join(dir, "report.src.html");
  writeFileSync(file, `---\n${front}\n---\n${body}`);
  return file;
}

describe("share card (link previews)", () => {
  const example = path.join(skillDir, "assets/example.src.html");
  const metaTags = (html: string) => Object.fromEntries([...html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)].map((m) => [m[1], m[2]]));

  test("every build carries Open Graph text tags without an image", () => {
    const { html, share } = buildReport(example);
    const tags = metaTags(html);
    expect(tags["og:title"]).toBe("Search API latency: why p90 doubled after the index migration");
    expect(tags["og:site_name"]).toBe("Technical report");
    expect(tags["og:description"].length).toBeGreaterThan(20);
    expect(tags["og:description"].length).toBeLessThanOrEqual(240);
    expect(tags["og:description"]).not.toMatch(/<|&lt;/);
    expect(tags["twitter:card"]).toBe("summary");
    expect(tags["twitter:data1"]).toBe("28 August 2026");
    expect(tags["twitter:label2"]).toBe("Reading time");
    expect(tags["og:image"]).toBeUndefined();
    expect(share.stats).toHaveLength(4);
    expect(share.stats[0]).toEqual({ value: "430ms", label: "p90 latency since 12 Aug (was 205 ms)", tone: "bad" });
  });

  test("--card-image adds a large-image card and rejects unusable URLs", () => {
    const url = "https://files.myslop.app/abc123/example.card.png";
    const tags = metaTags(buildReport(example, { cardImage: url }).html);
    expect(tags["og:image"]).toBe(url);
    expect(tags["og:image:width"]).toBe("1200");
    expect(tags["og:image:height"]).toBe("630");
    expect(tags["twitter:card"]).toBe("summary_large_image");
    expect(() => buildReport(example, { cardImage: "card.png" })).toThrow(/absolute https URL/);
    expect(() => buildReport(example, { cardImage: "https://x.test/card.svg" })).toThrow(/PNG or JPEG/);
    expect(() => buildReport(example, { cardImage: `${url}?private=1` })).toThrow(/private/);
  });

  test("description falls back from card_description to bottom line to standfirst", () => {
    const body = '<section class="summary"><p class="bottom-line">The <strong>bottom</strong> line &amp; more.</p></section>';
    const tagsFor = (front: string) => metaTags(buildReport(source(body, `title: T\ndate: 2026-10-01\n${front}`)).html)["og:description"];
    expect(tagsFor("standfirst: Lead text")).toBe("The bottom line &amp; more.");
    expect(tagsFor("card_description: Custom preview")).toBe("Custom preview");
    expect(metaTags(buildReport(source("<p>x</p>", "title: T\nstandfirst: Lead text")).html)["og:description"]).toBe("Lead text");
  });

  test("card HTML uses only report content, in the house style", async () => {
    const { cardHtml } = await import(path.join(skillDir, "scripts/card.mjs"));
    const { html, info } = cardHtml(example, { fonts: false });
    expect(html).toContain('class="share-title');
    expect(html).toContain("Search platform · Performance assessment");
    expect(html).toContain('<div class="share-v bad">430ms</div>');
    expect(html).not.toMatch(/<script\b|https?:\/\//);
    expect(info.stats).toHaveLength(4);
  });
});

describe("reports build", () => {
  test("builds the bundled example into one self-contained, script-free file", () => {
    const { html, warnings, counts, sections } = buildReport(path.join(skillDir, "assets/example.src.html"));
    expect(warnings).toEqual([]);
    expect(sections).toBe(6);
    expect(counts.charts).toBe(4);
    expect(counts.figures).toBe(4);
    expect(counts.tables).toBe(2);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/\b(?:src|href)="https?:\/\/[^"]*\.(?:css|js|woff2?)"/);
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).toContain('<span class="f-n">Figure 4</span>');
    expect(html).toContain('<span class="h-n">3.2</span>');
    expect(html).toContain('<span class="h-n">A</span>Evidence index');
    expect(html).toContain("28 August 2026");
    expect(html).toContain('class="toc"');
  });

  test("reports are unbranded: the masthead names the document type only", () => {
    const { html } = buildReport(path.join(skillDir, "assets/example.src.html"));
    expect(html).toContain('<span class="masthead-series">Technical report</span>');
    expect(html).not.toMatch(/brand-mark|brand-name|Ledger/);
  });

  test("rejects scripts, styles and external assets in the body", () => {
    expect(() => buildReport(source('<section class="summary"><p>x</p></section><script>alert(1)</script>'))).toThrow(/Scripts are not allowed/);
    expect(() => buildReport(source("<style>p{}</style>"))).toThrow(/house stylesheet/);
    expect(() => buildReport(source('<img src="https://example.com/a.png" alt="a">'))).toThrow(/External image/);
  });

  test("requires front matter with a title and reports invalid chart specs by number", () => {
    expect(() => buildReport(source("<p>x</p>", "date: 2026-10-01"))).toThrow(/title/);
    const bad = source('<figure class="figure"><figcaption>x</figcaption><script type="application/json" data-chart>{"type":"pie","data":[]}</script></figure>');
    expect(() => buildReport(bad)).toThrow(/Chart 1 \(pie\): Unknown chart type/);
  });

  test("warns about missing summary and uncaptioned figures", () => {
    const { warnings } = buildReport(source("<section><h2>Only</h2><figure><p>x</p></figure></section>"));
    expect(warnings.join("\n")).toMatch(/summary/);
    expect(warnings.join("\n")).toMatch(/figcaption/);
  });

  test("every chart type renders accessible SVG with house colour classes", () => {
    const specs: Record<string, unknown> = {
      bar: { type: "bar", alt: "a", data: [{ label: "A", value: 3 }, { label: "B", value: 1 }], highlight: ["A"] },
      column: { type: "column", categories: ["Q1", "Q2"], series: [{ name: "x", values: [1, 2] }] },
      stacked: { type: "stacked", percent: true, categories: ["a"], series: [{ name: "x", values: [1] }, { name: "y", values: [3], color: "bad" }] },
      line: { type: "line", x: ["a", "b", "c"], series: [{ name: "x", values: [1, null, 3] }], markers: [{ x: "b", label: "m" }] },
      range: { type: "range", data: [{ label: "r", low: 1, mid: 2, high: 3, max: 5 }] },
    };
    expect(Object.keys(specs).sort()).toEqual([...CHART_TYPES].sort());
    for (const spec of Object.values(specs)) {
      const svg = renderChart(spec);
      expect(svg).toStartWith("<svg class=\"chart");
      expect(svg).toContain('role="img"');
      expect(svg).not.toMatch(/NaN|undefined/);
      expect(svg).toMatch(/class="[^"]*\bc(?:1|m|bad)\b/);
    }
    expect(() => renderChart({ type: "bar", data: [{ label: "x", value: "3" }] })).toThrow(/finite number/);
    expect(() => renderChart({ type: "bar", data: [{ label: "x", value: 3, color: "#ff0000" }] })).toThrow(/Unknown colour/);
  });

  test("bar charts reserve room for long display labels inside the viewBox", () => {
    const svg = renderChart({ type: "bar", data: [{ label: "Timed out", value: 63.8, display: "63.8% (1,894)" }, { label: "Injected", value: 2.1, display: "2.1% (63)" }] });
    const width = Number(svg.match(/viewBox="0 0 (\d+)/)![1]);
    const x = Number(svg.match(/<text x="([\d.]+)"[^>]*class="value-label">63\.8% \(1,894\)/)![1]);
    // Monospace at 11.5px is about 7.1px per character.
    expect(x + "63.8% (1,894)".length * 7.1).toBeLessThanOrEqual(width);
  });

  test("column chart reference labels sit in the legend, not across the columns", () => {
    const svg = renderChart({ type: "column", categories: ["a", "b"], series: [{ name: "p50", values: [1, 2] }], reference: { value: 0.8, label: "800 ms budget" } });
    expect(svg).toContain('class="legend-label">800 ms budget');
    expect(svg).not.toContain('class="ref-label"');
  });
});

describe("report-writer agent", () => {
  const file = path.join(root, "agents/report-writer.md");
  const text = readFileSync(file, "utf8");
  const meta = YAML.parse(text.slice(4, text.indexOf("\n---", 4))) as Record<string, unknown>;

  test("pins Opus 5.5 with the provider extension and the reports skill", () => {
    expect(meta.name).toBe("report-writer");
    expect(meta.model).toBe("anthropic-claude-code/claude-opus-5-5");
    expect(meta.extensions).toBe("../extensions/anthropic-claude-code.ts");
    expect(meta.skills).toBe("reports");
    expect(path.resolve(path.dirname(file), String(meta.skillPath))).toBe(skillDir);
    expect(meta.allowNestedSubagents).toBe(false);
    const tools = String(meta.tools).split(",").map((t) => t.trim());
    for (const forbidden of ["subagent", "workflow_run", "interactive_shell"]) expect(tools).not.toContain(forbidden);
  });

  test("leaves publication and verification with the parent", () => {
    expect(text).toContain("Do not upload, publish");
    expect(text.replace(/\s+/g, " ")).toContain("Never invent");
    expect(readFileSync(path.join(skillDir, "SKILL.md"), "utf8")).toContain("Never launch an agent CLI through the shell");
  });

  test("the skill makes uploading the checked report a standard final step", () => {
    const skill = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const meta = YAML.parse(skill.split("---")[1]);
    expect(meta.description).toContain("uploaded to files.myslop.app");
    expect(skill).toContain("### 6. Upload and hand over");
    expect(skill).toContain('"https://files.myslop.app/$(basename "$1")$2"');
    // Card first, then rebuild with its URL, then upload the report and check what Slack sees.
    const order = ["scripts/card.mjs", "CARD_URL=$(put", '--card-image "$CARD_URL"', 'URL=$(put "$OUT")', "Slackbot-LinkExpanding"].map((s) => skill.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(skill).toContain("Never upload the card\n  publicly for a private report");
    expect(skill).toContain("Do not upload a report that\n  failed its checks");
  });
});
