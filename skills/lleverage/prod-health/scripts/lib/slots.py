#!/usr/bin/env python3
"""Recurring slots (experimental): a key's daily burst at the same local time.

Customers' scheduled workflows fire at the same wall-clock time every weekday
(10:00 Europe/Amsterdam, say) and some fail the same way each time. The baseline
holds one flat per-hour peak per key, so a two-minute burst averages away when the
baseline is captured and then raises a spike every day. A slot says "this key
bursts by about N between 10:00 and 10:10 local time on weekdays". A window that
overlaps the slot may exceed the normal threshold by up to N without raising;
every other window is judged exactly as before.

Slots live in $PH_STATE_ROOT/<env>/slots.json, next to the baseline, so a
baseline capture never touches them. With no slots file nothing changes. Set
PH_SLOTS=off (or pass --no-slots to assess.py) to ignore the file.

  slots.py learn --key K [--key K2] --at HH:MM [--minutes 10] [--tz Europe/Amsterdam]
                 [--days weekdays] [--lookback 10] [--min-days 6] [--min-count N]
                 [--allowance N] [--note TEXT] [--dry-run]
      run the owning checks over the slot on each of the last LOOKBACK matching
      days (read-only) and store the slot when the key would have raised there
      (count >= its normal threshold for that window, or MIN_COUNT if given) on at
      least MIN_DAYS of them. The allowance is the largest count seen, unless given.
  slots.py add --key K --at HH:MM --allowance N [--minutes 10] [--tz ...] [--days ...] --note TEXT
  slots.py rm --key K [--at HH:MM]
  slots.py list
Common: --env E, --file PATH (default $PH_STATE_ROOT/<env>/slots.json).
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_ROOT = os.environ.get("PH_STATE_ROOT", os.path.expanduser("~/.local/state/prod-health"))
DEFAULT_TZ = "Europe/Amsterdam"
DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
DAY_SETS = {"weekdays": {0, 1, 2, 3, 4}, "weekends": {5, 6}, "all": set(range(7))}
# Which check owns a key (the same prefixes as assess.py's OWNERS).
OWNERS = [("k8s.", "k8s"), ("alert", "alerts"), ("loki.", "loki-errors"), ("http.", "http"), ("wf.", "workflows"),
          ("sentry.", "sentry"), ("posthog.", "posthog"), ("dispatch.", "dispatch")]


def enabled():
    return os.environ.get("PH_SLOTS", "on").strip().lower() not in ("0", "off", "false", "no")


def default_path(env):
    return os.path.join(STATE_ROOT, env, "slots.json")


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    return [s for s in (data.get("slots") or []) if isinstance(s, dict) and s.get("key")]


def days_of(spec):
    spec = (spec or "weekdays").strip().lower()
    if spec in DAY_SETS:
        return DAY_SETS[spec]
    out = set()
    for d in spec.split(","):
        d = d.strip()[:3]
        if d not in DAY_NAMES:
            raise ValueError(f"bad --days '{spec}': use weekdays, weekends, all or mon,tue,...")
        out.add(DAY_NAMES.index(d))
    return out


def parse_hhmm(text):
    h, m = text.split(":")
    return int(h), int(m)


def occurrence(slot, local_date):
    """The slot's [start, end) on a local date, in UTC."""
    tz = ZoneInfo(slot.get("tz") or DEFAULT_TZ)
    h, m = parse_hhmm(slot["at"])
    start = dt.datetime(local_date.year, local_date.month, local_date.day, h, m, tzinfo=tz)
    end = start + dt.timedelta(minutes=int(slot.get("minutes") or 10))
    return start.astimezone(dt.timezone.utc), end.astimezone(dt.timezone.utc)


def matches(slots, key, start, end):
    """Slots of KEY with an occurrence that overlaps the window [start, end) (UTC
    datetimes), each with that occurrence. A slot counts once per window."""
    out = []
    if not (start and end):
        return out
    for s in slots:
        if s.get("key") != key:
            continue
        try:
            tz = ZoneInfo(s.get("tz") or DEFAULT_TZ)
            wanted = days_of(s.get("days"))
        except (ValueError, KeyError):
            continue
        d, last = start.astimezone(tz).date() - dt.timedelta(days=1), end.astimezone(tz).date()
        while d <= last:
            if d.weekday() in wanted:
                a, b = occurrence(s, d)
                if a < end and b > start:
                    out.append((s, a, b))
                    break
            d += dt.timedelta(days=1)
    return out


def allowance(slots, key, start, end):
    """Extra count a window may hold for KEY because it overlaps recurring slots."""
    found = matches(slots, key, start, end)
    total = sum(float(s.get("allowance") or 0) for s, _, _ in found)
    return (int(total) if total.is_integer() else total), found


def describe(slot):
    return f"{slot['at']}+{int(slot.get('minutes') or 10)}m {slot.get('tz') or DEFAULT_TZ} {slot.get('days') or 'weekdays'}"


def owner(key):
    return next((c for p, c in OWNERS if key.startswith(p)), None)


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def save(path, slots):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "slots": slots}, fh, indent=1)
    os.replace(tmp, path)


def upsert(slots, new):
    same = lambda s: (s["key"], s["at"], s.get("tz"), s.get("days")) == (new["key"], new["at"], new.get("tz"), new.get("days"))  # noqa: E731
    return [s for s in slots if not same(s)] + [new]


def counts_from(results, keys, rates, window_s):
    """{key: (count, threshold)} from one run's results, or None when the owning
    check wasn't measured. The threshold is what assess.py's spike rule (or new
    rule, for a key the baseline lacks) needs over this window."""
    status = {r.get("check"): r.get("status") for r in results}
    out = {}
    for k in keys:
        c = owner(k)
        if status.get(c) in (None, "unavailable"):
            out[k] = None
            continue
        series = [s for r in results if r.get("check") == c for s in r.get("series", []) if s.get("key") == k]
        count = sum((s.get("count") or 0) for s in series)
        rule = series[0] if series else {}
        if k in rates:
            threshold = max(rule.get("min_spike", 10), rule.get("ratio", 3.0) * max(rates[k] * window_s / 3600.0, 1.0))
        else:
            threshold = rule.get("min_new", 5)
        out[k] = (count, round(threshold, 2))
    return out


def run_checks(runner, env, checks, minutes, end):
    cmd = [runner, "--env", env, "--window", f"{minutes}m", "--end", iso(end), "--results", "--only", ",".join(checks),
           "--timeout", "240"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    dec, text, i, out = json.JSONDecoder(), proc.stdout, 0, []
    while i < len(text):
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            break
        obj, i = dec.raw_decode(text, i)
        out.extend(obj if isinstance(obj, list) else [obj])
    return [r for r in out if isinstance(r, dict) and r.get("check")]


def learn(args, path):
    tz = ZoneInfo(args.tz)
    wanted = days_of(args.days)
    now = parse_now(args.now)
    checks = sorted({owner(k) for k in args.key} - {None})
    if not checks:
        sys.exit("learn: no check owns these keys")
    probe = {"at": args.at, "minutes": args.minutes, "tz": args.tz}
    dates, d = [], now.astimezone(tz).date()
    while len(dates) < args.lookback and len(dates) < 400:
        if d.weekday() in wanted and occurrence(probe, d)[1] <= now:
            dates.append(d)
        d -= dt.timedelta(days=1)
    rates = ((load_json(args.baseline) or {}).get("rates") or {}) if args.baseline else {}
    per_day = []
    for d in dates:
        a, b = occurrence(probe, d)
        print(f"{d} {DAY_NAMES[d.weekday()]} {iso(a)}..{iso(b)}: running {','.join(checks)} (read-only)...", file=sys.stderr)
        counts = counts_from(run_checks(args.runner, args.env, checks, args.minutes, b), args.key, rates, args.minutes * 60)
        per_day.append({"date": d.isoformat(), "start": iso(a), "end": iso(b), "counts": counts})
    slots = load(path)
    stored = []
    for k in args.key:
        measured = [p for p in per_day if p["counts"][k] is not None]
        need = lambda p: args.min_count if args.min_count is not None else p["counts"][k][1]  # noqa: E731
        seen = [p for p in measured if p["counts"][k][0] >= need(p)]
        bar = f"{args.min_count:g}" if args.min_count is not None else \
            "its threshold " + "/".join(sorted({f"{p['counts'][k][1]:g}" for p in measured}) or ["?"])
        print(f"{k}: " + ", ".join(f"{p['date']}={p['counts'][k][0] if p['counts'][k] is not None else '?'}" for p in per_day))
        if len(seen) < args.min_days:
            print(f"  not recurring: {len(seen)} of {len(measured)} measured days reached {bar} "
                  f"(need {args.min_days}); nothing stored")
            continue
        peak = max(p["counts"][k][0] for p in seen)
        slot = {"key": k, "tz": args.tz, "at": args.at, "minutes": args.minutes, "days": args.days,
                "allowance": args.allowance if args.allowance is not None else peak,
                "learned": {"at": iso(now), "lookback": len(per_day), "measured": len(measured), "seen": len(seen),
                            "bar": bar, "peak": peak,
                            "counts": {p["date"]: (p["counts"][k] or (None,))[0] for p in per_day}},
                "note": args.note or "", "by": "learn"}
        print(f"  recurring: {len(seen)} of {len(measured)} days reached {bar}; slot {describe(slot)} "
              f"allowance {slot['allowance']:g}" + (" (dry run, not stored)" if args.dry_run else ""))
        slots = upsert(slots, slot)
        stored.append(k)
    if stored and not args.dry_run:
        save(path, slots)
        print(f"slots written: {path} ({len(slots)} slot(s))")
    return 0 if stored else 1


def load_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def parse_now(text):
    if not text:
        return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    t = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--env", default=os.environ.get("PH_ENV", "production"))
    common.add_argument("--file")
    slot = argparse.ArgumentParser(add_help=False)
    slot.add_argument("--tz", default=DEFAULT_TZ)
    slot.add_argument("--minutes", type=int, default=10)
    slot.add_argument("--days", default="weekdays")
    slot.add_argument("--note", default="")
    ap = argparse.ArgumentParser(description="Recurring slots (experimental); see references/baselines.md")
    sub = ap.add_subparsers(dest="cmd", required=True)
    le = sub.add_parser("learn", parents=[common, slot])
    le.add_argument("--key", action="append", required=True)
    le.add_argument("--at", required=True)
    le.add_argument("--lookback", type=int, default=10)
    le.add_argument("--min-days", type=int, default=6)
    le.add_argument("--min-count", type=float, help="count that makes a day recurring (default: the key's threshold)")
    le.add_argument("--baseline", help="baseline for the thresholds (default <state>/<env>/baseline.json)")
    le.add_argument("--allowance", type=float)
    le.add_argument("--dry-run", action="store_true")
    le.add_argument("--now", help="learn from the days before this time (default now)")
    le.add_argument("--runner", default=os.path.join(HERE, "..", "prod-health.sh"))
    ad = sub.add_parser("add", parents=[common, slot])
    ad.add_argument("--key", required=True)
    ad.add_argument("--at", required=True)
    ad.add_argument("--allowance", type=float, required=True)
    rm = sub.add_parser("rm", parents=[common])
    rm.add_argument("--key", required=True)
    rm.add_argument("--at")
    sub.add_parser("list", parents=[common])
    args = ap.parse_args()
    args.env = "production" if args.env == "prod" else args.env
    path = args.file or default_path(args.env)
    if args.cmd in ("learn", "add"):
        try:
            parse_hhmm(args.at)
            days_of(args.days)
            ZoneInfo(args.tz)
        except Exception as e:  # noqa: BLE001
            sys.exit(f"{args.cmd}: {e}")
    if args.cmd == "learn":
        args.baseline = args.baseline or os.path.join(STATE_ROOT, args.env, "baseline.json")
        return learn(args, path)
    slots = load(path)
    if args.cmd == "add":
        if not args.note:
            sys.exit("add: --note is required (who agreed and why)")
        new = {"key": args.key, "tz": args.tz, "at": args.at, "minutes": args.minutes, "days": args.days,
               "allowance": args.allowance, "note": args.note, "by": "human",
               "added": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
        save(path, upsert(slots, new))
        print(f"slot added: {args.key} {describe(new)} allowance {args.allowance:g}")
    elif args.cmd == "rm":
        keep = [s for s in slots if not (s["key"] == args.key and (args.at is None or s.get("at") == args.at))]
        save(path, keep)
        print(f"removed {len(slots) - len(keep)} slot(s) for {args.key}")
    else:
        for s in slots:
            learned = s.get("learned") or {}
            extra = f" seen {learned['seen']}/{learned['measured']} days, learned {learned['at']}" if learned else f" added {s.get('added', '?')}"
            print(f"{s['key']}\t{describe(s)}\tallowance {float(s.get('allowance') or 0):g}\t{extra.strip()}\t{s.get('note', '')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
