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

## Recurring slots (experimental)

The baseline has no time of day: each key has one per-hour peak, taken over 6h
slices. A burst that comes at the same local time every weekday, such as
customers' scheduled workflows that fire at 10:00 Europe/Amsterdam and fail in
their own nodes, averages away in a capture and then raises a spike every day.
Raising the key's rate to cover it (`accept`, or a merge over the burst) makes
the key less sensitive at every hour. A recurring slot covers only that slot.

Slots live in `slots.json`, next to the baseline. A capture never touches them.

```json
{"version": 1, "slots": [{"key": "http.svc:workflow-service|500", "tz": "Europe/Amsterdam",
  "at": "10:00", "minutes": 10, "days": "weekdays", "allowance": 12, "note": "…", "by": "learn",
  "learned": {"at": "…", "lookback": 10, "measured": 10, "seen": 8, "peak": 12, "counts": {"2026-10-27": 10, "…": 0}}}]}
```

- A slot is a local time (`at`, `minutes` long) in a named timezone on a set of
  days (`weekdays`, `weekends`, `all` or `mon,tue,…`), so a clock change moves
  it with the customers' schedules: 10:00 Amsterdam is 08:00Z in summer and
  09:00Z in winter.
- When a check window overlaps the slot, the key may exceed its normal threshold
  by `allowance` without raising. The normal threshold is `max(min_spike, ratio x
  expected)` for a spike, or `min_new` for a new key. Within the allowance the
  finding goes under `recurring` in the report (and in `--watch` output) and is
  not raised. Past it, the finding is raised as usual with "above recurring slot
  …" in its title and the slot in its evidence.
- Any window that doesn't overlap the slot (the same burst at 14:00Z, the slot's
  time on a weekend for a `weekdays` slot) is judged exactly as before.
- Only the `new` and `spike` rules use slots. Ratios, drops, presence and absolute
  findings never do.
- The switch: with no `slots.json` nothing changes. `PH_SLOTS=off`, or
  `assess.py --no-slots`, ignores the file. `assess.py --slots PATH` reads another.

Learn a slot rather than guessing it. `slot learn` runs only the owning checks
(read-only, one run per day, about 10 s each) over the slot on each of the last
`--lookback` (10) matching local days, and stores the slot only if the key would
have raised there, that is if it reached its normal threshold for that window
(`--min-count N` to set a number instead), on at least `--min-days` (6) of them.
The allowance is the largest count seen on those days (`--allowance N` to set
it). An unavailable check leaves that day unmeasured, not zero.

```bash
# Look first: prints each day's count and the verdict, stores nothing.
scripts/baseline.sh slot learn --key 'http.svc:workflow-service|500' --key 'loki.error:workflow-service' \
  --at 10:00 --minutes 10 --days weekdays --dry-run
# Store it, with a note naming who agreed and why.
scripts/baseline.sh slot learn --key 'http.svc:workflow-service|500' --key 'loki.error:workflow-service' \
  --at 10:00 --minutes 10 --days weekdays --note "Tom approved <date> (<task>): <why>"
scripts/baseline.sh slot list            # also shown by: baseline.sh show
scripts/baseline.sh slot rm --key 'http.svc:workflow-service|500' [--at 10:00]
scripts/baseline.sh slot add --key K --at HH:MM --allowance N --note "…"   # by hand, no learning
```

Pick `--at` and `--minutes` tightly around the burst: the allowance applies to
any window touching the slot. Re-run `slot learn` (it replaces the slot with the
same key, time, timezone and days) when the burst grows, and remove the slot when
the schedule stops. A slot needs a human's agreement, like `accept`.

The seeded noise (`scripts/data/seed-noise.json`) holds the long-standing items
from October 2026: Argo CD cache errors, graph-data-tables-service warn volume,
TP Vision (org-j251sez8bl) node HTTP errors, customer node-execution errors in
logs (measured by the workflows check instead), sandbox warm-pool churn, the
browser ResizeObserver warning and opaque cross-origin "Script error.".
