#!/usr/bin/env python3
"""Compare prod-health check results with the stored baseline and render a report.

Input: one or more check results (JSON objects, one per line or concatenated) on
stdin or from files. Output: a compact text report, or JSON with --json.

  assess.py [--env E] [--json] [--baseline PATH | --no-baseline] [--save-last] FILE|- ...
  assess.py --capture [--merge] [--env E] FILE|- ...     # write baseline rates
  assess.py --watch [--state PATH] FILE|- ...            # compact items for unattended watchers

--state PATH marks each finding new, escalated, reraise or unchanged against the
previous runs (see references/watching.md) and keeps a source that has been
unavailable for --unavailable-minutes as an item of its own.

Baseline file: $PH_STATE_ROOT/<env>/baseline.json (see references/baselines.md).
"""
import argparse
import datetime as dt
import fcntl
import fnmatch
import json
import os
import re
import sys

STATE_ROOT = os.environ.get("PH_STATE_ROOT", os.path.expanduser("~/.local/state/prod-health"))
SEV_ORDER = {"sev1": 0, "sev2": 1, "sev3": 2, "info": 3}
# Which check owns a series key (used when merging partial captures).
OWNERS = [("k8s.", "k8s"), ("alert", "alerts"), ("loki.", "loki-errors"), ("http.", "http"), ("wf.", "workflows"),
          ("sentry.", "sentry"), ("posthog.", "posthog"), ("dispatch.", "dispatch")]
EXIT = {"healthy": 0, "incomplete": 4}
DEFAULTS = {"min_new": 5, "min_spike": 10, "ratio": 3.0, "drop_min_expected": 20, "drop_ratio": 0.1}


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_results(paths):
    results = []
    for p in paths:
        text = sys.stdin.read() if p == "-" else open(p, encoding="utf-8").read()
        dec = json.JSONDecoder()
        i = 0
        while i < len(text):
            while i < len(text) and text[i].isspace():
                i += 1
            if i >= len(text):
                break
            obj, i = dec.raw_decode(text, i)
            results.extend(obj if isinstance(obj, list) else [obj])
    return [r for r in results if isinstance(r, dict) and r.get("check")]


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def per_hour(count, window_s):
    return count * 3600.0 / max(window_s, 1)


def owner(key):
    return next((c for p, c in OWNERS if key.startswith(p)), None)


def merged_series(r):
    """Series by key. Duplicate keys (e.g. several org namespaces collapsed to
    org-*) are summed, never overwritten."""
    out = {}
    for s in r.get("series", []):
        if s["key"] in out:
            prev = out[s["key"]]
            out[s["key"]] = {**prev, "count": (prev.get("count") or 0) + (s.get("count") or 0)}
        else:
            out[s["key"]] = dict(s)
    return out


class Orgs:
    """Resolve org ids, short names and org-<short> namespaces to display names."""

    def __init__(self, path):
        self.by_id, self.by_short = {}, {}
        for oid, v in (load_json(path, {}) or {}).items():
            self.by_id[oid] = v.get("name") or oid
            if v.get("short"):
                self.by_short[v["short"]] = v.get("name") or v["short"]

    def name(self, token):
        if token in self.by_id:
            return self.by_id[token]
        short = token[4:] if token.startswith("org-") else token
        return self.by_short.get(short)

    def label(self, text):
        if not text or not (self.by_id or self.by_short):
            return text

        def sub(m):
            tok = m.group(0)
            n = self.name(tok)
            return f"{n} ({tok})" if n else tok

        return re.sub(r"\borg-(?:[0-9a-f]{8}-[0-9a-f-]{27}|[a-z0-9]{5,12})\b(?! \()", sub, text)


def noise_match(noise, key):
    for n in noise:
        if fnmatch.fnmatchcase(key, n.get("pattern", "")):
            return n
    return None


def assess(results, baseline, args):
    rates = (baseline or {}).get("rates", {})
    means = (baseline or {}).get("means", {})
    ratios = (baseline or {}).get("ratios", {})
    presence = set((baseline or {}).get("presence", []))
    noise = (baseline or {}).get("noise", [])
    have_baseline = bool(baseline and (rates or presence))
    findings, suppressed, info = [], [], []

    def add(f, check):
        f = dict(f)
        f["check"] = check
        n = noise_match(noise, f["key"])
        if n:
            f["suppressed_by"] = n.get("pattern")
            suppressed.append(f)
        else:
            findings.append(f)

    for r in results:
        check, win = r["check"], r.get("window_s") or 1800
        for f in r.get("findings", []):
            add(f, check)
        series = merged_series(r)
        for s in series.values():
            key, count = s["key"], s.get("count", 0) or 0
            win = s.get("window_s") or r.get("window_s") or 1800
            rules = s.get("rules", ["new", "spike"])
            hint = s.get("hint", "sev3")
            ev = dict(s.get("evidence") or {})
            ev["count"] = count
            base = rates.get(key)
            expected = None if base is None else base * win / 3600.0
            ev["baseline_per_h"] = None if base is None else round(base, 2)
            ev["now_per_h"] = round(per_hour(count, win), 2)
            ns = s.get("namespace")
            mk = lambda kind, title: {"hint": hint, "key": key, "title": title, "kind": kind, "evidence": ev,  # noqa: E731
                                      **({"namespace": ns} if ns else {})}
            if "ratio_of" in s:
                den = series.get(s["ratio_of"], {}).get("count", 0)
                bden = rates.get(s["ratio_of"])
                prev = ratios.get(key)
                if prev is None and base is not None and bden:
                    prev = base / bden  # older baselines without paired ratios
                if den and count >= s.get("min_spike", 10) and prev is not None:
                    cur = count / den
                    ev.update(rate_now=round(cur, 3), rate_baseline=round(prev, 3))
                    if cur >= 2 * prev and cur - prev >= 0.05:
                        add(mk("rate", f"{s['title']}: {cur:.0%} of runs vs {prev:.0%} baseline"), check)
                continue
            if not have_baseline:
                continue
            if base is None and "new" in rules and count >= s.get("min_new", DEFAULTS["min_new"]):
                add(mk("new", f"NEW {s['title']} x{count}"), check)
            elif base is not None and "spike" in rules and count >= s.get("min_spike", DEFAULTS["min_spike"]) \
                    and count >= s.get("ratio", DEFAULTS["ratio"]) * max(expected, 1.0):
                add(mk("spike", f"{s['title']} x{count} ({count / max(expected, 0.01):.1f}x baseline {expected:.1f})"), check)
            mean_exp = (means.get(key, base) or 0) * win / 3600.0 if base is not None else 0
            if base is not None and "drop" in rules and mean_exp >= s.get("drop_min_expected", DEFAULTS["drop_min_expected"]) \
                    and count < DEFAULTS["drop_ratio"] * mean_exp:
                add({**mk("drop", f"{s['title']} went quiet: {count} vs {mean_exp:.0f} expected"),
                     "hint": s.get("drop_hint", "sev2")}, check)
        if r.get("status") != "ok":
            info.append({"check": check, "status": r.get("status"), "notes": r.get("notes", [])})

    if have_baseline:
        for r in results:
            for p in r.get("data", {}).get("presence", []):
                if p["key"] not in presence:
                    add({"hint": p.get("hint", "sev3"), "key": p["key"], "title": f"NEW {p['title']}",
                         "kind": "new", "evidence": p.get("evidence", {}),
                         **({"namespace": p["namespace"]} if p.get("namespace") else {})}, r["check"])

    deploys = []
    for r in results:
        deploys.extend(r.get("data", {}).get("deploys", []))
    for f in findings:
        if f["check"] != "deploys":
            f["candidates"] = candidates(f, deploys)
    findings.sort(key=lambda f: (SEV_ORDER.get(f.get("hint"), 9), f["check"], -(f.get("evidence", {}).get("count") or 0)))
    return findings, suppressed, info, deploys, have_baseline


def candidates(f, deploys):
    ns = f.get("namespace") or ""
    def score(d):
        dns = d.get("namespaces") or [d.get("namespace", "")]
        if ns and ns in dns:
            return 0
        if ns.startswith("org-") and any(x.startswith("org-") for x in dns):
            return 0
        if f["check"] in ("posthog", "http") and "app" in dns:
            return 1
        if f["check"] == "workflows" and any(x.startswith("org-") or x == "workflow-service" for x in dns):
            return 1
        return 2
    ranked = sorted((d for d in deploys if d.get("kind") != "build"), key=lambda d: d.get("at", ""), reverse=True)
    ranked.sort(key=score)
    out = []
    for d in ranked:
        if score(d) <= 1 or len(out) < 2:
            out.append(d.get("summary") or d.get("workload"))
        if len(out) >= 3:
            break
    return out


def overall(findings, results=()):
    if not findings:
        # Nothing found is only "healthy" if every source was actually checked.
        return "healthy" if all(r.get("status") == "ok" for r in results) else "incomplete"
    return min((f.get("hint", "sev3") for f in findings), key=lambda h: SEV_ORDER.get(h, 9))


def parse_iso(text):
    try:
        return dt.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except (TypeError, ValueError):
        return None


def sev_rank(sev):
    return SEV_ORDER.get(sev, 9)


def track(findings, results, path, now, reraise_h, unavailable_min, orgs):
    """Mark findings against the watch state and return the watch items.

    A key is new when the state has not seen it within the last reraise_h hours,
    escalated when its severity is worse than the one last announced, reraise when
    it is still present reraise_h hours after it was last announced, and otherwise
    unchanged. A source unavailable for unavailable_min minutes becomes an item
    (key source-unavailable:<check>) tracked the same way. The state file is locked
    so overlapping runs (a 15m and a 2h watcher) share it safely."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path + ".lock", "w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = load_json(path, {}) or {}
        keys = state.get("keys", {})
        sources = state.get("sources", {})
        forget = dt.timedelta(hours=reraise_h)
        stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        items = []

        def mark(key, severity, summary, extra):
            entry = keys.get(key)
            seen = parse_iso((entry or {}).get("last_seen"))
            if entry is None or seen is None or now - seen > forget:
                entry = {"first_seen": stamp}
                change = "new"
            elif sev_rank(severity) < sev_rank(entry.get("announced_severity")):
                change = "escalated"
            elif now - (parse_iso(entry.get("announced_at")) or now) >= forget:
                change = "reraise"
            else:
                change = "unchanged"
            if change != "unchanged":
                entry.update(announced_at=stamp, announced_severity=severity)
            entry.update(last_seen=stamp, severity=severity, summary=summary[:300])
            keys[key] = entry
            # status is the watcher contract's name for change; last_raised is when
            # the key was last announced (new, escalated or re-raised).
            item = {"key": key, "severity": severity, "summary": summary, "status": change, "change": change,
                    "first_seen": entry["first_seen"], "last_raised": entry.get("announced_at"), **extra}
            items.append(item)
            return item

        for f in findings:
            item = mark(f["key"], f.get("hint", "sev3"), f"{f['check']}: {orgs.label(f['title'])}",
                        {"check": f["check"], "kind": f.get("kind")})
            f["change"], f["first_seen"] = item["change"], item["first_seen"]
            f["status"], f["last_raised"] = item["status"], item["last_raised"]
            ev = f.get("evidence") or {}
            item["evidence"] = {k: (str(v)[:300] if k in ("sample", "query") else v) for k, v in ev.items()
                                if not isinstance(v, (dict, list)) or len(json.dumps(v)) <= 400}
            if f.get("candidates"):
                item["candidates"] = f["candidates"]
        for r in results:
            check = r["check"]
            if r.get("status") != "unavailable":
                sources.pop(check, None)
                continue
            since = sources.setdefault(check, stamp)
            started = parse_iso(since) or now
            if now - started >= dt.timedelta(minutes=unavailable_min):
                notes = "; ".join(n for n in r.get("notes", []) if n)[:300]
                mark(f"source-unavailable:{check}", "sev3", f"{check} has been unavailable since {since}: {notes or 'no detail'}",
                     {"check": check, "kind": "unavailable"})
        # Forget what has not been seen for longer than the re-raise period.
        for key in [k for k, e in keys.items() if now - (parse_iso(e.get("last_seen")) or now) > forget]:
            del keys[key]
        write_atomic(path, {"version": 1, "updated_at": stamp, "keys": keys, "sources": sources}, indent=1)
    return items


def render_text(results, findings, suppressed, info, deploys, have_baseline, baseline, orgs, env):
    first = results[0] if results else {}
    lines = []
    bl = "none (run baseline.sh capture)" if not have_baseline else \
        f"{baseline.get('captured_at', '?')} over {baseline.get('window', '?')}"
    lines.append(f"prod-health {env}  window={first.get('window')} {first.get('start')} .. {first.get('end')}  baseline={bl}")
    srcs = {r["check"]: r.get("status") for r in results}
    bad = [f"{c}={s}" for c, s in srcs.items() if s != "ok"]
    v = overall(findings, results)
    lines.append(f"VERDICT: {v.upper() + '?' if v.startswith('sev') else v}  findings={len(findings)} suppressed={len(suppressed)}"
                 f"  sources ok={sum(1 for s in srcs.values() if s == 'ok')}/{len(srcs)}" + (f" ({', '.join(bad)})" if bad else ""))
    if findings:
        lines.append("")
        lines.append("FINDINGS (hint = suggested severity; you decide)")
        for f in findings:
            tag = f" ({f['change']} since {f['first_seen']})" if f.get("change") else ""
            lines.append(f"  [{f.get('hint', '?')}] {f['check']}: {orgs.label(f['title'])}{tag}")
            ev = f.get("evidence") or {}
            extra = {k: v for k, v in ev.items() if k not in ("count", "baseline_per_h", "now_per_h", "query", "sample")}
            if extra:
                lines.append("        " + orgs.label(json.dumps(extra, separators=(",", ":"), ensure_ascii=False))[:300])
            if ev.get("sample"):
                lines.append("        sample: " + str(ev["sample"])[:200])
            if ev.get("query"):
                lines.append("        query: " + str(ev["query"])[:240])
            if f.get("candidates"):
                lines.append("        deployed in window: " + "; ".join(c for c in f["candidates"] if c)[:300])
    lines.append("")
    for r in results:
        s = r.get("data", {}).get("summary")
        notes = [n for n in r.get("notes", []) if n]
        status = r.get("status")
        head = f"-- {r['check']}: {status}" + (f"  {orgs.label(s)}" if s else "")
        lines.append(head)
        for n in notes[:6]:
            lines.append("     " + orgs.label(n)[:300])
    if suppressed:
        keys = sorted({f"{f['key']}" for f in suppressed})
        lines.append(f"-- suppressed as known noise ({len(suppressed)}): " + ", ".join(keys)[:400])
    return "\n".join(lines)


def capture(results, args):
    """Write per-hour rates. With --merge, keep the higher of old and new rates
    (spike detection), fold the new values into a per-key running mean (drop
    detection) and keep the peak paired failure share (ratio rule). Keys whose
    owning check was unavailable in this slice keep their old values."""
    path = args.baseline or os.path.join(STATE_ROOT, args.env, "baseline.json")
    old = load_json(path, {}) or {}
    merge = args.merge
    rates = dict(old.get("rates", {})) if merge else {}
    means = dict(old.get("means", {})) if merge else {}
    samples = dict(old.get("samples", {})) if merge else {}
    ratios = dict(old.get("ratios", {})) if merge else {}
    presence = set(old.get("presence", [])) if merge else set()
    measured = {r["check"] for r in results if r.get("status") != "unavailable"}
    window = None
    new = {}
    for r in results:
        window = r.get("window")
        if r.get("status") == "unavailable":
            continue
        series = merged_series(r)
        for k, s in series.items():
            new[k] = per_hour(s.get("count", 0) or 0, s.get("window_s") or r.get("window_s") or 1800)
            if "ratio_of" in s:
                den = series.get(s["ratio_of"], {}).get("count", 0)
                if den:
                    share = (s.get("count", 0) or 0) / den
                    ratios[k] = max(share, ratios.get(k, 0.0)) if merge else share
        for p in r.get("data", {}).get("presence", []):
            presence.add(p["key"])
    for k in set(rates) | set(new):
        if k not in new and owner(k) not in measured:
            continue  # not measured this slice: leave it alone
        v = new.get(k, 0.0)
        # A key first seen now was zero in earlier slices where its check ran.
        n = int(samples[k]) if k in samples else (int(old.get("slices", 1) or 1) if merge else 0)
        rates[k] = max(v, rates.get(k, 0.0))
        means[k] = (means.get(k, 0.0) * n + v) / (n + 1)
        samples[k] = n + 1
    slices = (int(old.get("slices", 1) or 1) + 1) if merge else 1
    out = {
        "env": args.env,
        "captured_at": now_iso(),
        "window": window if slices == 1 else f"{slices} x {window}",
        "slices": slices,
        "rates": dict(sorted(rates.items())),
        "means": dict(sorted((k, round(v, 4)) for k, v in means.items())),
        "samples": dict(sorted(samples.items())),
        "ratios": dict(sorted((k, round(v, 4)) for k, v in ratios.items())),
        "presence": sorted(presence),
        "noise": old.get("noise", []),
        "history": (old.get("history", []) + [{"at": now_iso(), "action": "merge" if merge else "capture",
                                                 "window": window, "end": results[0].get("end") if results else None,
                                                 "keys": len(new), "unavailable": sorted({r["check"] for r in results} - measured)}])[-50:],
    }
    write_atomic(path, out, indent=1)
    print(f"baseline written: {path} ({len(rates)} rates over {slices} slice(s), "
          f"{len(presence)} known alerts, {len(out['noise'])} noise patterns)")


def write_atomic(path, obj, indent=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=indent)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*", default=["-"])
    ap.add_argument("--env", default=os.environ.get("PH_ENV", "production"))
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--baseline")
    ap.add_argument("--no-baseline", action="store_true")
    ap.add_argument("--save-last", action="store_true")
    ap.add_argument("--capture", action="store_true")
    ap.add_argument("--merge", action="store_true")
    ap.add_argument("--exit-code", action="store_true", help="exit 0 healthy, 3 findings, 4 incomplete")
    ap.add_argument("--state", help="watch state file: mark findings new, escalated, reraise or unchanged")
    ap.add_argument("--watch", action="store_true", help="print compact watch items; exit 0 with none, 3 with some")
    ap.add_argument("--reraise-hours", type=float, default=6.0)
    ap.add_argument("--unavailable-minutes", type=float, default=60.0)
    ap.add_argument("--now", help=argparse.SUPPRESS)  # tests: the watch state's clock
    args = ap.parse_args()
    results = load_results(args.files or ["-"])
    if args.capture:
        capture(results, args)
        return 0
    bpath = args.baseline or os.path.join(STATE_ROOT, args.env, "baseline.json")
    baseline = None if args.no_baseline else load_json(bpath, None)
    orgs = Orgs(os.path.join(STATE_ROOT, args.env, "org-names.json"))
    findings, suppressed, info, deploys, have_baseline = assess(results, baseline, args)
    for f in findings + suppressed:
        names = sorted({n for n in (orgs.name(t) for t in re.findall(r"org-[0-9a-z-]{5,40}", f["key"] + " " + f["title"])) if n})
        if names:
            f["org_names"] = names
    items = None
    if args.watch and not args.state:
        args.state = os.path.join(STATE_ROOT, args.env, "watch-state.json")
    if args.state:
        now = parse_iso(args.now) if args.now else dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        items = track(findings, results, args.state, now,
                      args.reraise_hours, args.unavailable_minutes, orgs)
    report = {
        "env": args.env,
        "generated_at": now_iso(),
        "window": results[0].get("window") if results else None,
        "start": results[0].get("start") if results else None,
        "end": results[0].get("end") if results else None,
        "verdict": overall(findings, results),
        "baseline": None if not have_baseline else {"path": bpath, "captured_at": baseline.get("captured_at"),
                                                     "window": baseline.get("window")},
        "findings": findings,
        "suppressed": suppressed,
        "sources": {r["check"]: {"status": r.get("status"), "notes": r.get("notes", []),
                                 "summary": r.get("data", {}).get("summary")} for r in results},
        "deploys": deploys,
        "results": results,
    }
    if args.save_last:
        write_atomic(os.path.join(STATE_ROOT, args.env, "last.json"), report)
    if args.watch:
        watch = {k: report[k] for k in ("env", "generated_at", "window", "start", "end", "verdict")}
        watch.update(baseline_captured_at=(report["baseline"] or {}).get("captured_at"),
                     items=items, findings=items,
                     raise_count=sum(1 for i in items if i["change"] != "unchanged"),
                     sources={c: s["status"] for c, s in report["sources"].items()},
                     source_notes={c: [str(n)[:300] for n in s["notes"]][:5] for c, s in report["sources"].items()
                                   if s["status"] != "ok"},
                     state=args.state,
                     report=os.path.join(STATE_ROOT, args.env, "last.json") if args.save_last else None)
        print(json.dumps(watch, ensure_ascii=False))
        # Watch contract: 0 nothing to report, 3 items present; anything else is a failure.
        return 3 if items else 0
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        print(render_text(results, findings, suppressed, info, deploys, have_baseline, baseline or {}, orgs, args.env))
    # Exit status for this report only: 0 healthy, 3 findings, 4 incomplete.
    return EXIT.get(report["verdict"], 3) if args.exit_code else 0


if __name__ == "__main__":
    sys.exit(main())
