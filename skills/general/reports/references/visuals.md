# Charts, diagrams and graphics

## When to use a visual

Use a visual when the reader needs to **see** something that prose and tables make hard to
see:

| The reader needs to see… | Use |
|---|---|
| How a few quantities compare | `bar` (horizontal). Use `column` only for short labels or time buckets. |
| A change over time, a step change or a trend | `line`, with a `markers` entry on the event |
| How a whole splits into parts, and how that differs by group | `stacked` with `percent: true` |
| A distribution or latency profile (p10/p50/p90/p99) | `range` |
| A value against a threshold, budget or SLO | any chart with `reference` |
| How a request, job or decision moves through a system | `.flow`, `.steps` or a Graphviz diagram |
| What happened when | `.timeline` |
| Options and which was chosen | `.compare` |
| Exact values, many columns, or lookup | a table, not a chart |

Rules:

- **One message per visual.** The caption title states the finding ("Recall timed out on 64%
  of turns"), not the topic ("Recall outcomes").
- **Every figure has a `.sub` line** (what is plotted, unit, n and data window) and, where it
  matters, a `figure-note` naming the source.
- **Highlight what matters, mute the rest.** Use `highlight` on bar and column charts, or
  `"color":"muted"` for context series. Red (`bad`) is for the problem itself, not a
  decorative palette choice.
- **Do not repeat a chart as a table.** Give one or the other. A chart can be followed by a
  compact table of exact values in an appendix if readers will need them.
- **No pies, donuts, 3D, dual axes or icons as data.** A sorted bar or a 100% stacked bar
  is always clearer.
- Keep charts to 8 or fewer categories and 4 or fewer series. Shorten labels to 24
  characters or fewer. Split a busy chart in two.
- A technical report of normal length has about **3–6 figures**. Most sections need none.
  The summary needs none.

## Chart blocks

Put the spec in a JSON script tag inside a figure. The build replaces it with static SVG:

```html
<figure class="figure">
  <figcaption>Finding as a sentence<span class="sub">What, unit, n, window</span></figcaption>
  <script type="application/json" data-chart>{ "type": "bar", … }</script>
  <p class="figure-note">Source: …</p>
</figure>
```

Common options, which apply to every type:

| Key | Meaning |
|---|---|
| `unit` | Suffix for values: `"%"`, `"ms"`, `"s"`, `"tokens"`, `"k"`. |
| `prefix` | Prefix for values, e.g. `"£"`. |
| `decimals` | Fixed decimals for labels. The default is up to 2, trimmed. |
| `reference` | `{ "value": 800, "label": "800 ms budget" }` draws a red dashed threshold line. Column charts show its label in the legend row; other charts label the line itself. |
| `alt` | Accessible description. Write one when the caption alone does not convey the data. |
| `width` | The SVG coordinate width, default 720. The chart always scales to fit the figure. |

Colours: by default series take `c1`–`c6` (petrol, ochre, blue, plum, green, rust) in order.
Override them per series or per datum with `"color"`: `c1`…`c6`, `accent`, `muted`, `bad`,
`warn` or `good`.

### `bar`: horizontal bars

```json
{"type":"bar","unit":"%","decimals":0,"sort":"desc","highlight":["Timed out"],
 "data":[{"label":"Timed out","value":63.8},{"label":"Completed, no hits","value":28.0},
         {"label":"Injected","value":2.1},{"label":"Not logged","value":6.1}]}
```

- `data[].label`, `data[].value`, optional `data[].color`, and optional `data[].display` to
  override the value label (e.g. `"1,881 (91%)"`).
- `sort`: `"desc"` or `"asc"`. Without `sort`, the order is kept, which suits ordinal
  buckets.
- `highlight`: labels drawn in the accent colour, with all others muted.
- `max`: fix the scale, e.g. `100` for percentages.
- `track: false` hides the background track.

### `column`: vertical columns, grouped or stacked

```json
{"type":"column","unit":"%","categories":["Jun","Jul","Aug","Sep"],
 "series":[{"name":"remember failure rate","values":[13,8,14,23]}],"highlight":["Sep"],
 "reference":{"value":5,"label":"Target 5%"}}
```

- For multiple series, give several `series` entries and a legend is drawn. Add
  `"stacked": true` to stack them.
- `highlight` works only with a single series.
- `yLabel` is an optional axis caption. `labels: false` hides the value labels.

### `stacked`: horizontal stacked bars

```json
{"type":"stacked","percent":true,"categories":["Prefetch path","Hook-time read"],
 "series":[{"name":"Timeout","values":[1881,13],"color":"bad"},
           {"name":"Empty","values":[114,717],"color":"muted"},
           {"name":"With content","values":[63,0],"color":"c1"}]}
```

- `percent: true` normalises each row to 100% from raw counts. Pass the raw counts, not
  percentages.
- Without `percent`, bars are absolute and a total is printed at the end of each row.
- A single category with an empty label (`"categories":[""]`) gives a one-row "share bar".

### `line`: change over time

```json
{"type":"line","unit":"ms","x":["1 Jul","8 Jul","15 Jul","22 Jul"],
 "series":[{"name":"p90","values":[201,206,412,431]},{"name":"p50","values":[86,88,101,104],"color":"muted"}],
 "markers":[{"x":"15 Jul","label":"Cutover"}],"reference":{"value":250,"label":"SLO 250 ms"}}
```

- `null` in `values` leaves a gap.
- `"dashed": true` on a series draws it dashed, for forecasts or targets.
- With several series the name is written at the end of each line, so no legend is needed.
- `min` and `max` override the y scale. By default the scale starts at 0. Only start it
  above 0 when you are showing a small change on a large base, and say so in the `.sub`
  line.
- Points are drawn when there are 24 or fewer x values. `dots: false` hides them.

### `range`: distributions and percentiles

```json
{"type":"range","unit":"s","names":{"low":"p10","mid":"p50","high":"p90","max":"p99"},
 "reference":{"value":0.8,"label":"800 ms budget"},
 "data":[{"label":"recall","low":0.7,"mid":1.31,"high":2.09},
         {"label":"memory_search","low":0.8,"mid":1.51,"high":2.12},
         {"label":"gather_context","low":0.9,"mid":1.81,"high":3.15,"max":5.2}]}
```

- Each row draws a band from `low` to `high`, a tick at `mid`, and an optional dot at `max`.
  Omit any value you do not have, except `low` and `high`, which are required. If you only
  have p50 and p90, use p50 as `low` and name the band honestly with `names`, or use a
  grouped `column` instead.

## Diagrams

**Prefer the HTML components** (`.flow`, `.steps`, `.timeline`, `.compare`, `.cards`, all in
`components.md`). They follow the house style exactly, reflow on mobile and print cleanly.
Use them for linear pipelines, lifecycles, chronologies and option comparisons.

**Use Graphviz** when the structure is a real graph: branches, fan-out, cycles, or
components with several connections. The build runs `dot` and applies house defaults (fonts,
colours, box nodes):

```html
<figure class="figure diagram">
  <figcaption>Recall can only inject if it finishes before the hook reads it<span class="sub">Simplified request path</span></figcaption>
  <script type="text/vnd.graphviz" data-diagram>
  digraph {
    rankdir=LR;
    turn [label="User turn"];
    hook [label="PreGenerate hook"];
    mem  [label="Memory service", color="#a3402e", penwidth=1.5];
    turn -> hook;
    hook -> mem [label="recall"];
    mem -> hook [style=dashed, label="timeout after 800 ms"];
  }
  </script>
</figure>
```

Keep diagrams small: about 12 nodes or fewer and short labels. Use `rankdir=LR` for
pipelines. Highlight colours must come from the palette: bad `#a3402e`, warn `#a8701a`, good
`#3f7a4a`, accent `#1d6b72`, muted fill `#f3f1ec`. Use `style="filled,dashed"` for
optional or removed parts. If `dot` is unavailable, fall back to a `.flow` or `.steps`
component.

## Graphics you should not make

- Hero illustrations, stock imagery, emoji, decorative icons or generated pictures.
- Screenshots as a substitute for data you have as numbers.
- Charts of fewer than three values that a sentence covers ("63 of 2,970 turns").
