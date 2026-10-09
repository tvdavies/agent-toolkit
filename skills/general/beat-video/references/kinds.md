# Scene kinds

Every item takes `bars` (its length; the last item runs to `window.END`), and optionally `id`, `tag` (the mono label
top right) and `transition` (`wipe`, `flash`, `cut`). Beats inside an item count from its own first downbeat, so
items can be reordered without retiming. HTML is allowed in text; `<em>` is the accent colour (one per line).

| Kind | Options | Rhythm | Use for |
| --- | --- | --- | --- |
| `cover` | `kicker`, `title`, `line`, `foot` | static; the accent bar pulses | the first item: it is the thumbnail |
| `count` | `label`, `items: [[label, n], ...]`, `every` (beats, 1) | a column per beat, total rolls up | PRs per day, orders per week |
| `words` | `words: [html, ...]`, `every` (bars, 1) | one slams in per bar | a punchy intro or closing line |
| `statements` | `items: [[headline, sub], ...]`, `every` (bars, 2), `tail` | slow fades, sub-line on beat 3 | a breakdown or quiet section |
| `stat` | `kicker`, `steps: [v, ...]`, `unit`, `was`, `every` (beats, 1) | a step per beat, a track bar shrinks or grows | before → after numbers |
| `list` | `title`, `items: [[head, sub], ...]`, `every` (bars, 1) | an item per bar | three or four related changes |
| `rapid` | `items: [text, ...]`, `every` (beats, 2) | an item every two beats, progress ticks | many small fixes at the peak |
| `grid` | `items: [[number, line1, line2], ...]`, `every` (beats, 2) | a tile every two beats | a recap of the chapters |
| `end` | `kicker`, `title`, `line`, `foot`, `credit` (true) | fades in; shows `window.CREDIT` | the last item, over the fade |
| `custom` | `html`, `cls`, `init(el, c)`, `render(t, el, c)` | yours | anything else |

In `render(t, el, c)`, `c.a`/`c.z` are the scene's start and end in seconds and `c.bar0` its first bar:
`MV.b(c.bar0 + 1, 2)` is beat 2 of its second bar.

A brand layer can add kinds: `MV.kind("name", (item) => ({ el, init(c), render(t, c) }))`, using `MV.section(item,
classes, html)` and `MV.head(item, dark)`. `lleverage-feature-video` adds `chapter` (a product UI under a camera).

## Lengths that read well

At 120–126 BPM a bar is about 2 s. `words` 1 bar each; `list` and `chapter` 4 bars (one point per bar); `statements`
2 bars each; `rapid` 2 beats each, at most about 16 in a row; the `end` card 3–4 s over the fade. A two-minute track
holds a cover, an intro, six product chapters, a breakdown, two stats or lists, a rapid run, a recap and the end.
