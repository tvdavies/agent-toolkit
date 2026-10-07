---
name: reports
description: Produce consistent, self-contained HTML reports in one consistent house style, with charts and diagrams where they help. Use for technical assessments, investigations, incident reviews, design proposals, benchmark write-ups and status reports, or when asked to "write this up as a report", "turn this into a report", "make a shareable report" or regenerate an existing report in the standard style. Every finished report is uploaded to files.myslop.app and handed over as a link. Authoring goes to the report-writer subagent (Claude Opus 5.5) unless the current model is already Opus 5.5. Not for Slack messages, PR descriptions or short emails.
metadata:
  author: tvd
  version: 1.0.0
---

# Reports

Every report uses one unbranded house style: one build script, one stylesheet, the same
components and chart rules. Gathering the data and writing the document are separate jobs.
Any model can gather the data. Claude Opus 5.5 writes the document.

Paths below are relative to this skill's directory. Resolve them to absolute paths before
running commands or handing them to a subagent.

## Important

- **Do not invent or round away facts.** Every number, date, name and claim in the report
  must come from the brief or the cited source. If something is missing, flag it as a gap.
  Do not fill it in.
- **Bottom line first.** Every report opens with the `summary` section: one bottom-line
  sentence or two, then 3–7 numbered findings. A reader who stops there should still know
  what happened and what to do.
- **House style only.** Use the components in `references/components.md`. Do not add
  `<style>`, `<script>`, external fonts or CDN links. The build rejects them. The output must
  be one self-contained HTML file that works offline and in the sandboxed file viewer.
- **No branding.** Reports carry no logo, product mark or company brand, including ours,
  even when the subject is a company's product. The masthead names the document type
  (`series`), nothing else. Consistency comes from the layout, type and palette.
- **Customer or sensitive data stays out of git.** Work under `/tmp/reports/<slug>/` (or a
  directory the user names), never inside a repository unless asked.
- **Every report ends with an upload.** A report is finished when it is built, checked and
  uploaded to files.myslop.app, and the user has the link. Do not upload a report that
  failed its checks. Skip the upload only when the user says not to ("local only", "don't
  upload"), and say in the handover that it was not uploaded.

## Workflow

### 1. Set up the work directory

```bash
SKILL=<absolute path of this skill directory>
WORK=/tmp/reports/<slug>   # kebab-case, e.g. agent-memory-assessment
mkdir -p "$WORK"
```

### 2. Write the brief

The writer works from a brief, not from the conversation. Write `$WORK/brief.md` using
`references/brief-template.md`. It must hold everything the document needs: purpose,
audience, bottom line, findings with exact numbers, data tables for charts, caveats,
recommendations, evidence references and metadata.

When **restyling an existing report**, save the existing report (HTML or Markdown) as
`$WORK/source.html` or `$WORK/source.md`. Then write a short brief that says what to keep,
cut or change, and which charts or diagrams to add. Facts come from the source unchanged.

### 3. Author the document (Opus 5.5)

- **If you are Claude Opus 5.5**, author it yourself: read `references/components.md`,
  `references/visuals.md` and `references/writing.md`, then continue with step 4.
- **Otherwise**, delegate to the `report-writer` subagent with the `subagent` tool. Pass the
  brief path, work directory, output filename and any user preferences, for example:

  > Write the report described in /tmp/reports/agent-memory-assessment/brief.md. The
  > original report is source.html in the same directory. Work in that directory, write
  > report.src.html, build it to agent-memory-assessment-2026-10-01.html and run the render
  > check. Return the paths, the build output and any gaps you found.

  The writer builds and render-checks its own output, then returns a handoff. It does not
  upload: the parent uploads in step 6, after checking the report.
- If the `subagent` tool or the `report-writer` agent is unavailable, or the run fails, tell
  the user. Then author the report inline with the current model, and say that it was not
  written by Opus 5.5. Never launch an agent CLI through the shell instead.

### 4. Build

```bash
node "$SKILL/scripts/build-report.mjs" "$WORK/report.src.html" -o "$WORK/<slug>-<YYYY-MM-DD>.html"
```

The build inlines the CSS, fonts (about 160 KB), charts and Graphviz diagrams. It also
numbers sections, figures and tables, and generates the table of contents. Fix every
`error:`. Treat every `warning:` as a defect unless there is a stated reason.

### 5. Check before handing over

```bash
node "$SKILL/scripts/render-check.mjs" "$WORK/<slug>-<YYYY-MM-DD>.html" --out-dir "$WORK/render"
```

This saves desktop (1280 px) and mobile (420 px) screenshots in tiles, and flags horizontal
overflow and fonts that failed to load. Then:

1. Look at **every** desktop tile, and at least the first two mobile tiles. Fix overlapping
   labels, empty or squashed charts, very long tables and awkward breaks.
2. Check every number in the summary and in each chart against the brief.
3. Check that each chart's caption states its point and that each figure has a source or
   data window.

When the writer was a subagent, the parent still does items 1 and 2 before accepting the
report.

### 6. Upload and hand over

Uploading is part of every report. It uses the `file-upload` skill, which says where the
token lives and what to do on `401`. Every report is uploaded with a **share card**, so
the link shows a proper preview in Slack. The card image has to be at a public URL before
the page can reference it, so follow this order:

```bash
TOKEN="${MYSLOP_FILES_TOKEN:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/myslop-files/token")}"
put() { curl -sS --fail-with-body -X PUT -T "$1" -H "Authorization: Bearer $TOKEN" "https://files.myslop.app/$(basename "$1")$2"; }
OUT="$WORK/<slug>-<YYYY-MM-DD>.html"

# a. Render the card (1200×630 PNG) and look at it.
node "$SKILL/scripts/card.mjs" "$WORK/report.src.html" -o "$WORK/<slug>-<YYYY-MM-DD>.card.png"
# b. Upload the card. Always public: Slack cannot fetch a private image.
CARD_URL=$(put "$WORK/<slug>-<YYYY-MM-DD>.card.png")
# c. Rebuild the report so its meta tags point at the card.
node "$SKILL/scripts/build-report.mjs" "$WORK/report.src.html" -o "$OUT" --card-image "$CARD_URL"
# d. Upload the report (pass "?private=1" as the second argument for a private link).
URL=$(put "$OUT")
# e. Check what Slack will see: the page loads and the card tags are there.
curl -sI "$URL" | head -1
curl -s -A "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" "$URL" | grep -o '<meta property="og:image" content="[^"]*"'
curl -sI "$CARD_URL" | head -1
```

- **The card.** It shows the report type, date, eyebrow, title and up to four figures from
  the `.stats` block, or the bottom line if the report has none. It only uses content that
  is already in the report, so an anonymised report gives an anonymised card. `card.mjs`
  fails if the title or labels are cut off; shorten them rather than accept a clipped card.
  Look at the PNG before uploading it.
- **The preview text.** `og:description` is the summary's bottom line, cut to about 240
  characters (front matter `card_description:` overrides it). The card also shows two
  fields, **Date** and **Reading time**, worked out from the word count.
- **Private reports get a plain preview.** Slack's crawler cannot open a private link, so
  it shows only the URL. Skip steps a–c for a private report (build without
  `--card-image`), and tell the user the link will not unfurl. Never upload the card
  publicly for a private report: the card shows the title and headline figures.
- **No Chrome:** if `card.mjs` exits with code 3, build without `--card-image`. The link
  still gets a text preview. Say that the card image was skipped.

- **Visibility.** The default is an unlisted link: public, but under a random prefix that
  cannot be guessed or listed. Use `?private=1` (only the account owner can open it) when
  the user or the brief asks for private, or when the report holds credentials, personal
  data about named individuals, or anything the brief marks Confidential. Customer and
  project names alone do not require private. When unsure, ask before uploading.
- **Use the returned URL.** The response body is the permanent URL. Never construct it.
  Check it opens (`curl -sI <url>` returns `200`) before handing it over.
- **Updates replace the report in place.** Once a report link has been shared, publish fixes
  and revisions to the *same* URL so every existing link shows the latest version: rebuild
  with the same `--card-image` (read it from the live page's `og:image` if needed), then
  `put "$OUT"` against the full existing path instead of the bare filename:
  `curl -sS --fail-with-body -X PUT -T "$OUT" -H "Authorization: Bearer $TOKEN" "<existing URL>"`.
  It returns `200` and the same URL. Re-render and replace the card the same way if its
  figures or title changed. Slack keeps its cached preview per URL, so an in-place update
  does not refresh an unfurl that has already been posted. Delete stray or superseded uploads
  with `curl -X DELETE` on their URL (see the `file-upload` skill).
- **If the upload fails** (no token, `401`, network), give the user the local path and the
  error, and point them to the token setup in the `file-upload` skill. Do not report the
  report as published.

The handover gives the URL and its visibility, whether it has a share card, the local
path, who wrote it (Opus 5.5 inline or `report-writer`), and any gaps or caveats found
while checking.

## Source format at a glance

`report.src.html` is a front-matter block followed by an HTML body fragment:

```html
---
title: Platform agent memory: effectiveness and performance
standfirst: One or two sentences that tell the reader what this report found.
eyebrow: Platform agent · Assessment
date: 2026-10-01
author: Tom Davies (analysis assisted by Claude)
audience: Engineering and product
data: 17 Sep – 1 Oct 2026, production telemetry
status: Final
classification: Internal
ref: TR-2026-10-01
---

<section class="summary">
  <h2 class="unnumbered">Summary</h2>
  <p class="bottom-line">…</p>
  <ol><li><strong>Finding.</strong> Evidence.</li></ol>
</section>

<section>
  <h2>Scope and method</h2>
  …
</section>
```

The build handles section and figure numbering, the table of contents, anchors and table
wrapping. Do not number anything by hand. The full component catalogue is in
`references/components.md`, and a complete worked example is `assets/example.src.html`.

## Charts and diagrams

Use a visual when it shows a comparison, trend, distribution, composition, flow or
architecture faster than prose or a table. Do not add visuals for decoration. A long
technical report usually needs 3–6.

- **Charts**: `<script type="application/json" data-chart>{…}</script>` inside a
  `<figure class="figure">`. Types: `bar`, `column`, `stacked`, `line` and `range`. The
  build turns them into static SVG in the house palette. See `references/visuals.md`.
- **Diagrams**: use the HTML components (`.flow`, `.steps`, `.timeline`, `.compare`,
  `.cards`) for simple flows. Use Graphviz `data-diagram` blocks for real graphs, such as
  architecture or dependencies.
- **Inline magnitude bars** in table cells: `<span class="cell-bar" style="--v:64%"></span>`.

## Common issues

- `error: Front matter needs a title`: the file must start with `---`. Nothing may come
  before it, not even a blank line.
- `error: Chart N (...)`: the JSON spec is invalid. Charts are numbered in source order.
- `Graphviz dot is not installed`: use the `.flow` / `.steps` components instead, or
  install graphviz.
- Slack shows an old or empty preview: Slack caches previews per URL. Check the tags with
  the `curl -A Slackbot…` command in step 6, then share a fresh upload.
- `401 unauthorized` on upload: the token is missing or revoked. Ask the user to run
  `curl -fsS https://files.myslop.app/setup.sh | bash` in a terminal, then retry.
- The render check can't find Chrome: set `$CHROME` to a Chrome/Chromium binary. Without
  one, open the HTML in a browser and review it manually. Say that the automated check was
  skipped.
- Mobile chart text is small: the chart is too dense. Reduce the number of categories,
  shorten labels, or split it into two charts.
