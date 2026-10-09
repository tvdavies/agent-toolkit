// The plan: scene kinds laid end to end, each `bars` long. Fit it to the sections beats.mjs printed: put the
// quiet intro on a cover and words, start the main run on the first big lift, give the breakdown to
// "statements", and let the last item (the end card) run to window.END while the track fades.
// Kinds: cover, count, words, statements, stat, list, rapid, grid, end, custom (see references/kinds.md).
window.END = undefined; // seconds; defaults to the track's length
const PLAN = [
  { kind: "cover", bars: 2, kicker: "Team · Week 41", title: "One week<br><em>of shipping.</em>", line: "What changed, set to music.", foot: "example.com" },
  { kind: "count", bars: 2, tag: "The week in numbers", label: "pull requests merged", items: [["Mon", 12], ["Tue", 18], ["Wed", 9], ["Thu", 21], ["Fri", 15], ["Sat", 2], ["Sun", 1], ["Mon", 14]] },
  { kind: "words", bars: 3, words: ["Faster <em>pages.</em>", "Fewer <em>clicks.</em>", "Sturdier <em>runs.</em>"] },
  { kind: "list", bars: 4, tag: "Highlights", title: "Search<br><em>got smarter.</em>", items: [["Typo-tolerant matching", "Finds 'reciept' as 'receipt'."], ["Filters persist", "They survive a refresh."], ["Results stream in", "The first ten show at once."], ["Keyboard first", "Arrow keys and Enter work everywhere."]] },
  { kind: "stat", bars: 4, tag: "Build", kicker: "CI type-check", steps: [205, 180, 150, 120, 95, 70, 50, 32], unit: "s", was: "was 205s" },
  { kind: "rapid", bars: 4, tag: "Also this week", items: ["Smaller bundles", "Fewer retries", "Clearer errors", "Faster imports", "Quieter logs", "Better defaults", "Sharper icons", "Safer deletes"] },
  { kind: "statements", bars: 4, tag: "Under the hood", items: [["Long sessions<br><em>keep their context.</em>", "Compacted as they grow."], ["Crashed runs<br><em>pick up again.</em>", "When nothing had started."]] },
  { kind: "grid", bars: 4, tag: "The week", items: [["01", "Search", "smarter"], ["02", "Faster", "pages"], ["03", "Build", "205s → 32s"], ["04", "Under", "the hood"]] },
  { kind: "end", kicker: "Team · Week 41", title: "One week<br><em>of shipping.</em>", foot: "example.com" },
];
