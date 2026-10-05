#!/usr/bin/env python3
"""Normalise log lines, error messages and URL paths into stable signatures.

Masks ids, numbers, hashes, emails and quoted values so that the same error from
different sessions, orgs or requests groups together.

  normalise.py loki-signatures < lines.jsonl     # {ns,pod,container,line} -> aggregated JSONL
  normalise.py route PATH                        # print the masked route
"""
import json
import re
import sys

ANSI = re.compile(r"\x1b\[[0-9;]*m|\[[0-9;]{1,5}m")
PATTERNS = [
    (re.compile(r"\b(Org|Workflow|Session|User|Project|Execution|org|workflow|session|user|project|execution)(Id|ID|_id)?=[^\s,|]+"), r"\1\2=<v>"),
    (re.compile(r"\b(executing the node|node) [A-Za-z0-9_.-]+(?=,| failed| \|)"), r"\1 <node>"),
    (re.compile(r"\b(for app|application) [a-z0-9-]+(?=:)"), r"\1 <app>"),
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "<uuid>"),
    (re.compile(r"\b(org|wrk|prj|ses|run|exe|usr|sess|session|execution)-<uuid>"), r"\1-<id>"),
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"), "<email>"),
    (re.compile(r"https?://[^\s\"'<>]+"), lambda m: re.sub(r"\?.*$", "", m.group(0))),
    (re.compile(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"), "<ts>"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b"), "<ip>"),
    (re.compile(r"\b[0-9a-f]{12,}\b", re.I), "<hex>"),
    (re.compile(r"\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{10,}\b", re.I), "<id>"),
    (re.compile(r"\b(org|ns)-[a-z0-9]{5,12}\b"), r"\1-<short>"),
    (re.compile(r"\d+(?:\.\d+)?"), "N"),
]
QUOTED = re.compile(r"(['\"`])(?:(?!\1).){24,}?\1")


def mask(text, limit=140):
    t = ANSI.sub("", text or "").strip()
    for rx, rep in PATTERNS:
        t = rx.sub(rep, t)
    t = QUOTED.sub(r"\1…\1", t)
    t = re.sub(r"\s+", " ", t)
    return t[:limit]


ROUTE_SEG = re.compile(r"^(?:[0-9a-f-]{16,}|\d+|[a-z0-9]{1,4}-[0-9a-z-]{6,}|(?=[a-z0-9_-]*\d)[a-z0-9_-]{8,}|[A-Za-z0-9_-]{20,})$", re.I)


def route(path):
    p = (path or "").split("?")[0].split("#")[0]
    if p.startswith("http"):
        p = "/" + p.split("/", 3)[-1] if p.count("/") >= 3 else "/"
    segs = [(":id" if ROUTE_SEG.match(s) else s) for s in p.split("/")]
    # Lleverage app routes: /<orgShort>/projects/<id>/..., /<orgShort>/w/<slug>,
    # and an id after collection names.
    if len(segs) > 2 and segs[0] == "" and segs[2] in ("projects", "w", "settings", "admin", "p"):
        segs[1] = ":org"
    for i in range(1, len(segs) - 1):
        if segs[i] in ("projects", "w", "workflows", "sessions", "agents", "tables", "runs", "executions", "requests"):
            if segs[i + 1] not in ("", "new") and not segs[i + 1].startswith(":"):
                segs[i + 1] = ":id"
    return "/".join(segs)[:120] or "/"


def message_of(line):
    """Pick the human message out of a JSON or text log line."""
    s = ANSI.sub("", line).strip()
    if s.startswith("{"):
        try:
            obj = json.loads(s)
        except ValueError:
            obj = None
        if isinstance(obj, dict):
            parts = []
            for k in ("message", "msg", "error", "err", "reason"):
                v = obj.get(k)
                if isinstance(v, dict):
                    v = v.get("message") or v.get("msg") or json.dumps(v)[:120]
                if isinstance(v, str) and v and v not in parts:
                    parts.append(v)
            if parts:
                return " | ".join(parts[:2])
    # Drop a leading timestamp; keep level words, they help tell signatures apart.
    return re.sub(r"^\[?\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\]?\s*", "", s)


def ns_class(ns):
    return "org-*" if ns.startswith("org-") else ns


# Skip continuation lines (leading whitespace, quotes, markdown), then look for an
# error token anywhere, including at column zero.
STRICT = re.compile(r"""^(?![\s'"*]).*?(\bError:|\bERROR\b|"level":"(error|fatal)"|"severity":"(ERROR|CRITICAL)"|Unhandled|unhandledRejection|Traceback|^panic:|prisma:error|\bFATAL\b|\bException\b)""")


def loki_signatures():
    agg = {}
    for raw in sys.stdin:
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if rec.get("strict") and not STRICT.search(ANSI.sub("", rec.get("line", ""))):
            continue
        ns = rec.get("ns", "")
        msg = message_of(rec.get("line", ""))
        sig = mask(msg)
        if not sig:
            continue
        key = f"{ns_class(ns)}|{sig}"
        a = agg.setdefault(key, {"key": key, "ns_class": ns_class(ns), "signature": sig, "count": 0,
                                 "namespaces": {}, "sample": msg[:240], "cover": rec.get("cover")})
        a["count"] += 1
        if rec.get("cover") and (not a["cover"] or rec["cover"] < a["cover"]):
            a["cover"] = rec["cover"]
        a["namespaces"][ns] = a["namespaces"].get(ns, 0) + 1
    out = sorted(agg.values(), key=lambda a: -a["count"])
    for a in out:
        a["namespaces"] = dict(sorted(a["namespaces"].items(), key=lambda kv: -kv[1])[:8])
        print(json.dumps(a, ensure_ascii=False))


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    mode = sys.argv[1]
    if mode == "loki-signatures":
        loki_signatures()
    elif mode == "route":
        print(route(sys.argv[2] if len(sys.argv) > 2 else ""))
    elif mode == "mask":
        print(mask(sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()))
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
