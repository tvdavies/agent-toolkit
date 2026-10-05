# Baselines

One JSON file per environment: `~/.local/state/prod-health/<env>/baseline.json`.
The same directory (mode 700) also holds `last.json`, the last full report, which
`accept` reads. It also holds `org-names.json`, an org id to name and short name
cache with a six-hour TTL.

```json
{
  "env": "production",
  "captured_at": "2026-10-05T23:30:00Z",
  "window": "24h",
  "rates":    { "loki.error:argocd": 26.0, "wf.category:upstream_rejected": 5.5 },
  "presence": [ "alert:KubeJobFailed|minio" ],
  "noise":    [ { "pattern": "loki.sig:argocd|*", "note": "…", "by": "seed" } ],
  "history":  [ { "at": "…", "action": "capture", "window": "24h" } ]
}
```

- `rates` are per hour, taken from each series' count over the capture window. For
  Loki samples that hit the line cap, the rate uses the time span the sample covers.
- `presence` lists alerts known to be firing, and any keys a human accepted.
- `noise` holds glob patterns over finding keys. A finding that matches is
  suppressed: it is counted in the report, not listed.

## Commands

```bash
scripts/baseline.sh capture [--env E] [--window 24h]    # replace rates and presence; keep noise
scripts/baseline.sh capture --merge                     # keep the higher of old and new rates
scripts/baseline.sh seed                                # capture, plus data/seed-noise.json
scripts/baseline.sh show
scripts/baseline.sh accept '<finding key>' --note "why it's normal"
scripts/baseline.sh noise add '<glob>' --note "why"
scripts/baseline.sh noise rm '<glob>'
```

Capture during normal traffic. A 24h window covers the daily cycle. Don't capture
during an incident, or the incident becomes the baseline. If one is under way, wait,
or use `--end` to capture a healthy past day.

## Rules (`lib/assess.py`)

A series can carry `rules`, `min_new`, `min_spike`, `ratio` (default 3) and
`drop_min_expected`. `expected` is the baseline rate multiplied by the window.

| Rule | Fires when |
|---|---|
| `new` | The key is absent from the baseline and `count >= min_new` (default 5; Loki signatures 3; 4xx routes 20; 5xx 5) |
| `spike` | `count >= min_spike` and `count >= ratio x max(expected, 1)` |
| `drop` | `expected >= drop_min_expected` (default 20; pageviews, completions and dispatches 60) and `count < 10% of expected` |
| ratio (`wf.failed`) | The failure share is at least twice the baseline share, at least 5 points higher, and at least 10 failures |
| presence (alerts) | The alert key is not in `presence` |

Absolute findings (any crashloop or image pull failure, any critical alert, stuck
rollouts and dispatches, failed deploy builds, new Sentry issues) are never
baseline-compared. Silence one only with a noise pattern, and only when a human
agrees.

## Learning

- A human confirms a finding is normal: `accept <key>` raises that key's rate to
  what the last run observed. Further growth beyond 3x still alerts.
- Something should never alert, for example a customer's endpoint that always
  fails: `noise add` with a specific pattern and a note naming who agreed.
- A deliberate traffic change, such as a new large customer: `capture --merge`.
- Review the noise list now and then (`baseline.sh show`). Remove patterns that
  are no longer true.

The seeded noise (`scripts/data/seed-noise.json`) holds the long-standing items
from October 2026: Argo CD cache errors, graph-data-tables-service warn volume,
TP Vision (org-j251sez8bl) node HTTP errors, customer node-execution errors in
logs (measured by the workflows check instead), sandbox warm-pool churn, the
browser ResizeObserver warning and opaque cross-origin "Script error.".
