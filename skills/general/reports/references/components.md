# Report components

Everything a report needs is here. If something seems to be missing, use the closest
component. Do not add CSS. `assets/example.src.html` shows most of these in context.

## Front matter

| Key | Required | Shown as |
|---|---|---|
| `title` | yes | H1. Sentence case. It may state the finding ("Why p90 doubled after the migration"). |
| `standfirst` | strongly advised | Lead paragraph under the title: 1–3 sentences giving the answer, not the topic. |
| `eyebrow` | advised | Small label above the title: `Area · Report type`. |
| `date` | yes | `YYYY-MM-DD`, rendered as "1 October 2026". |
| `author` | yes | Include "analysis assisted by Claude" when that is true. |
| `audience` | advised | Who the report is for. |
| `data` | advised for data reports | The data window and source, e.g. `17 Sep – 1 Oct 2026, Loki`. |
| `status` | optional | Draft / Final / Superseded. |
| `classification` | advised | Internal / Confidential, plus a handling note if needed. |
| `ref` | optional | Document reference shown in the masthead and footer. |
| `series` | optional | Masthead and footer label (the report carries no brand). Default "Technical report". Others: "Incident review", "Design proposal", "Status report". |
| `card_description` | optional | Text for link previews (Slack etc.). Default: the summary's bottom line, cut to about 240 characters. |
| `meta_<Label>` | optional | Extra metadata row, e.g. `meta_Reviewers: A, B`. |
| `toc` | optional | `false` hides the contents sidebar. It is hidden automatically when there are fewer than three sections. |

Values are single lines and may contain inline HTML such as `<em>` and `<code>`.

## Structure

```html
<section class="summary">…</section>   <!-- always first -->
<div class="stats">…</div>             <!-- optional key figures, straight after the summary -->
<section><h2>…</h2> … </section>       <!-- numbered 01, 02, … -->
<section class="appendix"><h2 data-n="A">…</h2> … </section>
```

- `h2` starts a numbered section. `h3` is numbered within it (2.1, 2.2). Add
  `class="unnumbered"` to skip numbering, or `data-n="A"` to set a label such as an appendix
  letter.
- Do not use `h1` in the body. Use `h4` for small run-in labels inside cards or options.
- Give a heading an explicit `id` when you link to it: `<h3 id="prefetch">…</h3>`, then
  `<a href="#prefetch">§4.1</a>`. Otherwise ids are generated.

## Summary

```html
<section class="summary">
  <h2 class="unnumbered">Summary</h2>
  <p class="bottom-line">One or two sentences: the answer and what to do.</p>
  <ol>
    <li><strong>Headline finding with the number.</strong> One or two sentences of support.</li>
  </ol>
  <p><strong>Highest-value fix:</strong> optional closing line.</p>
</section>
```

## Key figures

```html
<div class="stats">
  <div class="stat bad"><span class="stat-value">2.1%</span><span class="stat-label">of turns received recalled memory</span></div>
  <div class="stat"><span class="stat-value">1.6<small>s</small></span><span class="stat-label">median wait before the hook reads recall</span></div>
</div>
```

Use 3–4 tiles, each showing a number that matters. The modifiers `bad`, `warn`, `good` and
`accent` colour the value. Put units in `<small>`. The label must say what the number counts.
The first four tiles also appear on the link-preview card. Keep labels to about 60 characters
so they fit there in two lines.

## Text

- `<p class="lead">` gives an emphasised opening paragraph within a section.
- Use `<strong>` for the key phrase in a paragraph, at most one or two per paragraph.
- Use `<code>` for identifiers, paths, config keys, event names and literal values.
- `<pre><code>` holds short code or log excerpts. Keep them under about 15 lines and trim
  them with `…`.
- `<span class="bad|warn|good">` colours a word or value in running text or a table cell.
  Use it sparingly.
- `<sup class="ref"><a href="#ref-3">3</a></sup>` is a citation that links to the references list.

## Callouts

```html
<div class="callout"><span class="callout-title">Key point</span><p>…</p></div>
```

Modifiers: `note` (grey: limitations, method notes), `info` (blue), `warn` (amber: caveats,
risks), `risk` (red: security or data-loss findings), `good` (green: what is working). Use
at most one or two per section. A callout that repeats the paragraph above it is noise.

## Badges

`<span class="badge p0">P0</span>`. Modifiers: `p0`/`high`/`bad`, `p1`/`medium`/`warn`,
`p2`/`low`/`info`, `good`/`done`, `accent`. Without a modifier the badge is neutral, which
suits owners, effort and areas.

## Tables

```html
<table>
  <caption>Recall outcome by retrieval path</caption>
  <thead><tr><th>Path</th><th class="num">Turns</th><th class="num">Timeout</th></tr></thead>
  <tbody>
    <tr><td>Startup prefetch</td><td class="num">2,065</td><td class="num bad">1,881 (91%)</td></tr>
    <tr class="total"><td>Total</td><td class="num">2,796</td><td class="num">1,894</td></tr>
  </tbody>
</table>
<p class="table-note">² Footnote for the table.</p>
```

- Mark numeric columns `class="num"` on both `th` and `td` so they right-align with tabular
  figures.
- Write `&ndash;` or `–` for "not applicable", never an empty cell.
- Use row classes `highlight` (accent tint) and `total` (rule above, bold).
- `table.compact` suits evidence indexes and dense appendices.
- Add a `<caption>` to any table the text refers to. The build numbers it "Table N".
- Tables are wrapped for horizontal scrolling automatically. Even so, keep them to 7
  columns or fewer. Split anything wider, or move it to an appendix.
- Inline magnitude bars, for share columns: `64% <span class="cell-bar" style="--v:64%"></span>`.
  Add `bad` or `warn` to colour the bar. This is the only inline `style` the build accepts
  without a warning.

## Figures

```html
<figure class="figure">
  <figcaption>Recall timed out on most turns<span class="sub">2,970 turns, 17 Sep – 1 Oct 2026</span></figcaption>
  <!-- chart, diagram, flow, or <img src="local.png" alt="…"> -->
  <p class="figure-note">Source: agent-service telemetry (Loki).</p>
</figure>
```

The build numbers figures ("Figure N") and gives each one an id of `fig-N` unless you set
your own. Captions state the finding. The `.sub` line says what is plotted and the unit. See
`visuals.md` for chart specs.

Local images are inlined as data URIs. Use them only for real screenshots, and always give
alt text.

## Diagram components

**Flow**, a left-to-right pipeline with arrows. It stacks vertically on mobile. Add
`class="flow vertical"` for a top-to-bottom flow.

```html
<div class="flow">
  <div class="node"><span class="node-label">Startup</span><b>Prefetch recall</b>800 ms deadline starts here</div>
  <div class="node bad"><span class="node-label">+1.6 s</span><b>PreGenerate hook</b>Deadline already passed</div>
</div>
```

Node modifiers: `accent`, `bad`, `warn`, `good`, `muted` (out of scope or inactive), `dark`
(the system under discussion).

**Steps**, a numbered sequence (procedure, request lifecycle):

```html
<ol class="steps"><li><b>Hook fires</b>PreGenerate reads L0 and recall.</li><li class="bad"><b>Timeout</b>…</li></ol>
```

**Timeline**, for dated events (incident chronology, rollout plan):

```html
<ol class="timeline"><li><time>16 Sep</time><div><b>LLE-13311 merged</b>Startup prefetch introduced.</div></li></ol>
```

Add `class="bad"` to an `li` to highlight it.

**Cards**, for 2–4 parallel concepts (definitions, components, options without a winner):

```html
<div class="cards"><div class="card"><span class="card-label">Layer</span><h4>L0 digest</h4><p>…</p></div></div>
```

**Compare**, for options side by side with the chosen one marked:

```html
<div class="compare"><div class="option"><h4>Option A</h4><p>…</p></div><div class="option chosen"><h4>Option B</h4><p>…</p></div></div>
```

## Recommendations

```html
<ol class="recs">
  <li>
    <span class="rec-title">Fix the prefetch deadline</span>
    <span class="rec-meta"><span class="badge p0">P0</span><span class="badge">agent-service</span><span class="badge">Effort: S</span></span>
    <p>What to change, why, and the expected effect with a number.</p>
  </li>
</ol>
```

Group long lists under `h3` headings by priority, for example "P0: make recall reach the
model". Numbering continues across every `.recs` list in the same `section`, so refer to
recommendations by number safely. Start a new `section` to restart at 1.

## Definitions and references

```html
<dl class="defs"><dt>L0</dt><dd>Recent-observation digest for the current session.</dd></dl>
<ol class="references"><li id="ref-1">…</li></ol>
```

## Wide content

Prose is limited to a comfortable measure of about 720 px. Figures, tables, stats, flows,
cards, compare blocks and recommendations use the wider column of about 1000 px
automatically. Wrap anything else that needs the full width in `<div class="wide">`.
