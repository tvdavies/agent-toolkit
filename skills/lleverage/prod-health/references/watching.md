# Watching production unattended

`prod-health.sh --watch` is for a scheduler that runs the sweep every few minutes
with no model and wakes an agent only when something changed. Sal's `check`
schedules use it.

```sh
prod-health.sh --window 15m --watch --state ~/.local/state/prod-health/production/watch-state.json
```

Output is one JSON object:

```json
{"env": "production", "window": "15m", "start": "…", "end": "…", "verdict": "sev3",
 "findings": [{"key": "loki.warn:session-service", "severity": "sev3",
               "summary": "loki-errors: warn lines in session-service x217306 (12720.4x baseline 17.1)",
               "status": "new", "change": "new",
               "first_seen": "2026-10-07T23:47:32Z", "last_raised": "2026-10-07T23:47:32Z",
               "check": "loki-errors", "kind": "spike",
               "evidence": {"count": 217306, "...": "..."}, "candidates": ["…"]}],
 "items": ["the same list as findings"],
 "raise_count": 1,
 "sources": {"k8s": "ok", "posthog": "partial", "sentry": "unavailable", "...": "..."},
 "source_notes": {"posthog": ["unavailable: no pageviews in the window, …"], "sentry": ["…"]},
 "state": "…", "report": "…/last.json"}
```

Exit status: 0 with no findings, 3 with findings (whatever their `status`), anything
else means the run failed. Wake someone only for findings whose `status` isn't
`unchanged`; `raise_count` counts them. `items` is the older name for `findings`
and `change` the older name for `status`; both stay for compatibility.

`sources` gives every check's status: `ok`, `partial` (some of it couldn't be
checked) or `unavailable`. Only `ok` means the source was fully checked; a PostHog
window with no pageviews, for instance, is `partial`, never `ok`.

Use `--watch`, not plain `--json`, for an unattended caller: `--json` also exits 4
("incomplete") when nothing was found but a source wasn't fully checked.

## Keys and changes

Finding keys are stable: they name the signal, not the count (`loki.warn:<ns>`,
`http.svc:<ns>|404`, `alert:<name>|<ns>`, `k8s.waiting:<ns>/<workload>:<reason>`,
`deploy.build:<service>`, `posthog.silent`). Severity is the script's hint
(`sev1`, `sev2`, `sev3`). `first_seen` is when the state first saw the key and
`last_raised` when it was last announced (`new`, `escalated` or `reraise`).
The state file is written atomically (a temporary file, then a rename).

| `status` | When |
|---|---|
| `new` | The state hasn't seen the key in the last `--reraise-hours` (6) hours |
| `escalated` | Its severity is worse than the one last announced |
| `reraise` | Still present `--reraise-hours` after it was last announced |
| `unchanged` | Anything else: don't wake anyone |

A source that has been `unavailable` for `--unavailable-minutes` (60) becomes an
item of its own, `source-unavailable:<check>` at `sev3`, and follows the same
rules, so it is raised at most once every six hours. A shorter outage only shows
in `sources`.

Every cadence (every 10 minutes over 15m, every 2 hours over 2h) should share
one state file, so a finding the short window raised isn't raised again by the
long one. The file is locked while it is updated. Delete it to start afresh;
everything present is then `new` once.

The watcher raises; it doesn't decide. Whoever is woken still confirms and grades
each item as `SKILL.md` says, and an unattended agent follows **Unattended runs**.
