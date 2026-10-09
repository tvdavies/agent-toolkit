// The plan, fitted to "Voxel Revolution" (122 BPM): quiet intro bars 0–7, drums from bar 7, peak at 23,
// breakdown 30–39, second build 39–62, fade from 62. This is the 2–9 October 2026 week video (Tom Davies,
// 344 PRs); replace the content and refit the bar counts to your track's sections (beats.mjs prints them).
// Facts: facts.json (facts.mjs). Every claim must trace to a merged PR; flagged features say so or stay out.
window.END = 129.9;
const PLAN = [
  { kind: "cover", bars: 2, kicker: "Tom Davies · 2–9 October 2026", title: "One week<br><em>in Lleverage.</em>", line: "What I shipped since the last business review.", foot: "lleverage.ai" },
  { kind: "count", bars: 2, tag: "The week in numbers", label: "pull requests merged",
    items: [["Fri", 56], ["Sat", 60], ["Sun", 11], ["Mon", 45], ["Tue", 49], ["Wed", 50], ["Thu", 24], ["Fri", 49]] },
  { kind: "words", bars: 3, words: ["Faster <em>pages.</em>", "Smarter <em>agents.</em>", "Sturdier <em>runs.</em>"] },
  CHAPTERS.steer({ n: 1 }),
  CHAPTERS.workflow({ n: 2 }),
  CHAPTERS.files({ n: 3 }),
  CHAPTERS.subagents({ n: 4 }),
  CHAPTERS.speed({ n: 5 }),
  CHAPTERS.apps({ n: 6 }),
  { kind: "statements", bars: 9, every: 2, tag: "Under the hood", tail: "Now, for the <em>engineers.</em>", items: [
    ["Long agent sessions<br><em>keep their context.</em>", "Every session runs on one context log, compacted as it grows."],
    ["A run that loses its pod<br><em>picks up again.</em>", "Recovered from the log when no side effect had started."],
    ["If Opus 5.5 refuses,<br><em>Sonnet 5.5 retries.</em>", "And the run ends with a clear message if it still can't."],
    ["Workflow services<br><em>hold no signing key.</em>", "Runs carry a scoped, expiring organisation token instead."]] },
  { kind: "stat", bars: 4, tag: "For the engineers · 07", kicker: "App type-check on TypeScript 7", steps: [205, 180, 150, 120, 95, 70, 50, 32], unit: "s", was: "was 205s" },
  { kind: "list", bars: 4, tag: "For the engineers · 08", title: "Cerbie<br><em>gates the merge.</em>", items: [
    ["Every PR gets a Cerbie review", "Should-fix findings now request changes."],
    ["CODEOWNERS is gone", "Cerbie's check and CI gate the merge."],
    ["Coding agents get Cerbie's rules", "Plus guidance for fixing review findings."],
    ["CodeRabbit reviews once per PR", "And again only when asked."]] },
  { kind: "rapid", bars: 8, tag: "Also this week", items: ["API responses compressed", "Static assets gzipped from the CDN", "Database client warmed before traffic", "Node catalogue cached",
    "AI error explanations cached", "Sandbox grep with Perl regex", "Runaway sandbox commands stopped", "Sandbox pod claimed on first use", "Read-only Project Files refuse writes",
    "Paused runs resume on their own version", "Large table imports stop timing out", "Connector lines behind the handle dots", "Every model call through LiteLLM",
    "Billing emails delivered again", "Web vitals from production", "Requests page opens PDFs"] },
  { kind: "grid", bars: 4, tag: "The week", items: [["01", "Steer the agent", "mid-run"], ["02", "Agent-built", "workflows"], ["03", "Files in,", "files out"], ["04", "Sub-agents", "by role"],
    ["05", "Faster", "first loads"], ["06", "Workflow", "apps"], ["—", "Under", "the hood"], ["07–08", "The engineering", "loop"]] },
  { kind: "words", bars: 3, words: ["344 PRs.", "8 days.", "On <em>main.</em>"] },
  { kind: "end", kicker: "Tom Davies · 2–9 October 2026", title: "One week<br><em>in Lleverage.</em>", foot: "lleverage.ai" },
];
