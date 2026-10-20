#!/usr/bin/env python3
"""Static guard for ad-hoc VictoriaMetrics (PromQL/MetricsQL) and Loki (LogQL) queries.

Used by scripts/query.sh; it never touches the network. It reads the query and the
requested time range and either prints a JSON plan (mode, range, step, limit) or
refuses with a message naming the safe shape (exit 3). It is a lint, not a full
parser: it errs on the side of refusing.

Why: on 20 Oct 2026 one range query, `max by (pod)(...)` over 5 days at step 60,
OOM-killed production vmsingle (LLE-16077), and on 14 Oct 2026 one LogQL query
with an epoch-sized range OOM-killed production Loki (LLE-15393).
"""
import argparse
import json
import re
import sys

H = 3600
D = 86400
MAX_RANGE_S = 24 * H          # longest range query (VM and Loki) and LogQL [range]
MAX_POINTS = 1440             # points per series in a range query or subquery
VM_MAX_LOOKBACK_S = 7 * D     # longest instant rollup window, e.g. max_over_time(x[7d])
LOKI_BROAD_MAX_S = 6 * H      # selectors narrowed only by a regex, e.g. namespace=~"org-.*"
LOKI_MAX_LIMIT = 5000         # Loki's own cap on returned lines

# Labels whose values churn (one per pod, container or scrape target). Grouping a
# multi-day window by one of them makes one series per pod that ever existed.
CHURN_LABELS = {
    "pod", "pod_name", "pod_ip", "pod_uid", "uid", "instance", "container_id", "id",
    "name", "exported_pod", "exported_instance", "replicaset", "job_name", "image_id",
}
# Loki labels that don't narrow a selector on their own.
LOKI_BROAD_LABELS = {"job", "cluster", "level", "detected_level", "stream", "node", "host"}

VM_AGGS = {
    "sum", "min", "max", "avg", "count", "group", "stddev", "stdvar", "topk", "bottomk",
    "quantile", "quantiles", "count_values", "limitk", "mad", "median", "mode", "share",
    "zscore", "any", "distinct", "geomean", "histogram", "outliers_mad", "outliersk",
    "outliers_iqr", "sum2", "topk_avg", "topk_max", "topk_min", "topk_median", "topk_last",
    "bottomk_avg", "bottomk_max", "bottomk_min", "bottomk_median", "bottomk_last",
}
VM_KEYWORDS = {
    "offset", "bool", "and", "or", "unless", "inf", "nan", "atan2", "default", "if",
    "ifnot", "keep_metric_names", "limit",
}
LIST_KEYWORDS = {"by", "without", "on", "ignoring", "group_left", "group_right"}

UNITS = {"ms": 0.001, "s": 1, "m": 60, "h": H, "d": D, "w": 7 * D, "y": 365 * D}
STR_RE = re.compile(r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|`[^`]*`')
MATCHER_RE = re.compile(
    r'([A-Za-z_][A-Za-z0-9_.]*)\s*(=~|!~|!=|=)\s*("(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|`[^`]*`)')
TOKEN_RE = re.compile(
    r'\s+|\{[^}]*\}|\[[^\]]*\]|"[^"]*"|\'[^\']*\'|`[^`]*`'
    r'|[A-Za-z_:][A-Za-z0-9_:]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[A-Za-z]*|.')


class Refused(Exception):
    def __init__(self, reason, safe):
        super().__init__(reason)
        self.reason, self.safe = reason, safe


def fmt_s(s):
    s = int(s)
    for unit, n in (("d", D), ("h", H), ("m", 60)):
        if s >= n and s % n == 0:
            return f"{s // n}{unit}"
    return f"{s}s"


def parse_dur(text, what="duration"):
    t = text.strip()
    if re.fullmatch(r"\d+(?:\.\d+)?", t):
        return float(t)  # MetricsQL reads a bare number as seconds
    parts = re.findall(r"(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)", t)
    if not parts or "".join(a + b for a, b in parts) != t:
        raise Refused(f"can't read the {what} '{text}'",
                      "write durations with plain units: 30s, 5m, 6h, 1d (no $__ variables or 'i' steps)")
    return sum(float(a) * UNITS[b] for a, b in parts)


def mask_strings(q):
    """Replace string contents with x, keeping quotes and positions."""
    return STR_RE.sub(lambda m: m.group(0)[0] + "x" * (len(m.group(0)) - 2) + m.group(0)[-1], q)


def unquote(v):
    v = v[1:-1]
    return v if v.startswith("`") else re.sub(r"\\(.)", r"\1", v)


def brackets(masked):
    """Every [range] as (lookback_s, None) and [range:resolution] as (lookback_s, resolution_s).
    A subquery with no resolution is counted at 1m, which is conservative."""
    out = []
    for m in re.finditer(r"\[([^\]]*)\]", masked):
        body = m.group(1).strip()
        if ":" in body:
            rng, res = body.split(":", 1)
            res = res.strip()
            out.append((parse_dur(rng, "range"), parse_dur(res, "subquery step") if res else 60.0))
        else:
            out.append((parse_dur(body, "range"), None))
    return out


def selectors(q, masked):
    """Every {...} block outside strings as (start index, [(label, op, value)])."""
    out = []
    for m in re.finditer(r"\{[^}]*\}", masked):
        body = q[m.start() + 1:m.end() - 1]
        out.append((m.start(), [(l, op, unquote(v)) for l, op, v in MATCHER_RE.findall(body)]))
    return out


def check_points(span, step, what):
    if step <= 0:
        raise Refused(f"{what} step must be positive", "use --step 1m or more")
    pts = span / step
    if pts > MAX_POINTS:
        raise Refused(
            f"{what} makes {int(pts)} points per series ({fmt_s(span)} at {fmt_s(step)}); the limit is {MAX_POINTS}",
            f"raise the {'resolution ([range:res])' if what == 'a subquery' else 'step'} to at least "
            f"{fmt_s(-(-span // MAX_POINTS))}, or shorten the range")


def auto_step(span):
    """Default step: about 360 points, at least 15s, rounded up to a whole minute above 1m."""
    step = max(15, span / 360)
    return float(-(-int(step) // 60) * 60) if step > 60 else float(int(step))


def scan_vm(masked):
    """Walk the PromQL tokens. Returns (selectors as (name, inside_aggregation), groupings)."""
    toks = [t for t in TOKEN_RE.findall(masked) if not t.isspace()]
    stack, pending, sels, groupings = [], None, [], []
    i = 0
    while i < len(toks):
        t, nxt = toks[i], toks[i + 1] if i + 1 < len(toks) else ""
        low = t.lower()
        if low in LIST_KEYWORDS and nxt == "(":
            j, labels = i + 2, []
            while j < len(toks) and toks[j] != ")":
                if toks[j] != ",":
                    labels.append(toks[j].strip("\"'`"))
                j += 1
            if low in ("by", "without"):
                groupings.append((low, labels))
            i = j + 1
            continue
        if t == "(":
            stack.append(pending or "paren")
            pending = None
        elif t == ")":
            if stack:
                stack.pop()
        elif re.fullmatch(r"[A-Za-z_:][A-Za-z0-9_:]*", t):
            if low in VM_AGGS and (nxt == "(" or nxt.lower() in ("by", "without")):
                pending = "agg"
            elif nxt == "(":
                pending = "fn"
            elif low not in VM_KEYWORDS:
                sels.append((t, "agg" in stack))
                if nxt.startswith("{"):
                    i += 1
        elif t.startswith("{"):
            sels.append((None, "agg" in stack))
        i += 1
    return sels, groupings


def guard_vm(q, rng, step):
    masked = mask_strings(q)
    for _, matchers in selectors(q, masked):
        for label, op, value in matchers:
            if label == "__name__" and op != "=":
                raise Refused(f"__name__{op}\"{value}\" selects metrics by pattern",
                              "name one metric per selector, e.g. kube_pod_status_phase{namespace=\"app\"}")
    sels, groupings = scan_vm(masked)
    if not sels:
        raise Refused("no metric selector found", "e.g. sum(rate(hubble_http_requests_total[5m]))")
    if any(name is None for name, _ in sels):
        raise Refused("a selector has no metric name ({...} matches every metric)",
                      "put the metric name in front: metric_name{label=\"value\"}")

    lookbacks = brackets(masked)
    lookback = max((lb for lb, _ in lookbacks), default=0)
    for lb, res in lookbacks:
        if res is not None:
            check_points(lb, res, "a subquery")

    plan = {"backend": "vm"}
    if rng is not None:
        if rng > MAX_RANGE_S:
            raise Refused(
                f"range query over {fmt_s(rng)}; the limit is 24h (LLE-16077: a 5-day range OOM-killed vmsingle)",
                "for a multi-day question use an instant rollup without --range, aggregated without pod: "
                "max(max_over_time(metric[5d])) or topk(10, max_over_time(metric[5d]))")
        if lookback > MAX_RANGE_S:
            raise Refused(f"a {fmt_s(lookback)} window inside a range query",
                          "keep [windows] in range queries to 24h, or drop --range and ask one instant rollup")
        step = step or auto_step(rng)
        check_points(rng, step, "the range query")
        plan.update(mode="range", range_s=rng, step_s=step, window_s=rng)
        return plan
    if step is not None:
        raise Refused("--step without --range", "add --range (24h at most), or drop --step for an instant query")
    if lookback > VM_MAX_LOOKBACK_S:
        raise Refused(f"a {fmt_s(lookback)} rollup window; the limit is 7d",
                      "use [7d] or less; VictoriaMetrics keeps 15 days but week-plus scans are heavy")
    plan.update(mode="instant", window_s=lookback)
    if lookback > MAX_RANGE_S:
        bare = [n for n, inside in sels if not inside]
        if bare:
            raise Refused(
                f"{fmt_s(lookback)} window without aggregation ({', '.join(sorted(set(bare)))} returns one series per pod)",
                f"wrap it: max(max_over_time({bare[0]}[{fmt_s(lookback)}])), "
                f"or topk(10, max_over_time({bare[0]}[{fmt_s(lookback)}])) to see the worst pods")
        for kind, labels in groupings:
            if kind == "without":
                raise Refused(f"without (...) on a {fmt_s(lookback)} window keeps pod and instance",
                              "use by (...) with stable labels only, such as namespace, container or job")
            churn = sorted(set(labels) & CHURN_LABELS)
            if churn:
                raise Refused(
                    f"by ({', '.join(churn)}) on a {fmt_s(lookback)} window makes one series per pod that ever existed "
                    "(LLE-16077: ~27,600 runner pods in 5 days)",
                    "aggregate without pod: max(max_over_time(metric[5d])), count(max_over_time(metric[5d]) >= 3), "
                    "or topk(10, max_over_time(metric[5d])) for the worst pods; for a per-pod view use [24h] or less")
    return plan


def wildcard(regex):
    for alt in regex.split("|"):
        core = re.sub(r"\(\?i\)|\^|\$|\.\*\??|\.\+\??", "", alt)
        if core in ("", "."):
            return True
    return False


def guard_loki(q, rng, step, limit):
    masked = mask_strings(q)
    sels = selectors(q, masked)
    if not sels:
        raise Refused("no stream selector found", "start with one, e.g. {namespace=\"app\", container=\"app\"}")
    broad = False
    for _, matchers in sels:
        narrow = [(l, op, v) for l, op, v in matchers
                  if l not in LOKI_BROAD_LABELS and ((op == "=" and v) or (op == "=~" and not wildcard(v)))]
        if not narrow:
            raise Refused(
                "the stream selector doesn't narrow anything (only wildcards, negations or job/level/cluster)",
                "name a namespace, container or app: {namespace=\"app\"} or {namespace=~\"org-.*\", container=\"workflow-service\"}")
        if not any(op == "=" for _, op, _ in narrow):
            broad = True
    lookbacks = brackets(masked)
    lookback = max((lb for lb, _ in lookbacks), default=0)
    if lookback > MAX_RANGE_S:
        raise Refused(f"a LogQL [{fmt_s(lookback)}] range; the limit is 24h (LLE-15393: one huge range OOM-killed Loki)",
                      "use [24h] or less, e.g. sum by (namespace) (count_over_time({namespace=\"app\"} |= \"error\" [1h]))")
    for lb, res in lookbacks:
        if res is not None:
            check_points(lb, res, "a subquery")
    metric = bool(lookbacks)
    plan = {"backend": "loki"}
    if not metric:
        rng = rng if rng is not None else H
        if step is not None:
            raise Refused("--step on a log query", "drop --step; log queries return lines, newest first")
        limit = 100 if limit is None else limit
        if not 0 < limit <= LOKI_MAX_LIMIT:
            raise Refused(f"--limit {limit}", f"use 1 to {LOKI_MAX_LIMIT} lines (default 100)")
        plan.update(mode="logs", range_s=rng, limit=limit)
        window = rng
    elif rng is not None:
        step = step or auto_step(rng)
        check_points(rng, step, "the range query")
        plan.update(mode="range", range_s=rng, step_s=step)
        window = rng + lookback
    else:
        if step is not None:
            raise Refused("--step without --range", "add --range (24h at most), or drop --step for an instant query")
        plan.update(mode="instant")
        window = lookback
    span = plan.get("range_s", 0)
    if span > MAX_RANGE_S:
        raise Refused(f"a {fmt_s(span)} query range; the limit is 24h (LLE-15393)",
                      "ask about 24h or less, or one instant count_over_time(...[24h]) for a day's total")
    if broad and window > LOKI_BROAD_MAX_S:
        raise Refused(
            f"a selector narrowed only by a regex over {fmt_s(window)}; the limit for those is 6h",
            "add an exact namespace/container/app matcher, or ask about 6h or less")
    plan["window_s"] = window
    return plan


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("backend", choices=["vm", "loki"])
    ap.add_argument("--query", required=True)
    ap.add_argument("--range")
    ap.add_argument("--step")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    try:
        if not a.query.strip():
            raise Refused("empty query", "pass the query as the second argument")
        rng = parse_dur(a.range, "--range") if a.range else None
        step = parse_dur(a.step, "--step") if a.step else None
        if a.backend == "vm":
            if a.limit is not None:
                raise Refused("--limit is for Loki log queries", "drop --limit; use topk(10, ...) to cap series")
            plan = guard_vm(a.query, rng, step)
        else:
            plan = guard_loki(a.query, rng, step, a.limit)
    except Refused as r:
        print(f"query.sh: refused: {r.reason}\n  safe shape: {r.safe}\n"
              "  (see the prod-health SKILL.md, 'Ad-hoc queries')", file=sys.stderr)
        sys.exit(3)
    print(json.dumps(plan))


if __name__ == "__main__":
    main()
