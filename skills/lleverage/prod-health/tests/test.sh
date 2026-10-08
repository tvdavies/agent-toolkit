#!/usr/bin/env bash
# Offline tests for the prod-health assessment and normalisation (no network).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; lib="$here/../scripts/lib"
state="$(mktemp -d)"; trap 'rm -rf "$state"' EXIT
mkdir -p "$state/production"; cp "$here/fixtures/baseline.json" "$state/production/baseline.json"
fail() { echo "FAIL: $*" >&2; exit 1; }

report="$(PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --json "$here/fixtures/results.jsonl")"
keys="$(jq -r '.findings[].key' <<<"$report")"
for k in 'k8s.waiting:org-gehfngf/workflow-deployment:CrashLoopBackOff' \
         'http.route:app|/api/public/workflow-session|401' \
         'wf.category:platform_error' 'wf.failed' 'posthog.pageviews' \
         'alert:KubePodCrashLooping|session-service' 'http.svc:app|404'; do
  grep -qxF "$k" <<<"$keys" || fail "expected finding $k; got: $keys"
done
for k in 'wf.category:upstream_rejected' 'loki.error:workflow-service' 'alert:KubeJobFailed|minio'; do
  ! grep -qxF "$k" <<<"$keys" || fail "unexpected finding $k"
done
jq -e '.suppressed | map(.key) | index("loki.error:argocd")' <<<"$report" >/dev/null || fail "argocd should be suppressed as noise"
jq -e '.verdict == "sev1"' <<<"$report" >/dev/null || fail "verdict should be sev1, got $(jq -r .verdict <<<"$report")"
jq -e '.findings[] | select(.key == "http.route:app|/api/public/workflow-session|401") | .kind == "spike" and (.candidates[0] | test("#7395"))' <<<"$report" >/dev/null \
  || fail "401 spike should be a spike with the app deploy as first candidate"
jq -e '.findings[] | select(.key | startswith("k8s.waiting")) | .candidates[0] | test("workflow-service")' <<<"$report" >/dev/null \
  || fail "crashloop in an org namespace should point at the workflow-service rollout"
jq -e '.sources.sentry.status == "unavailable"' <<<"$report" >/dev/null || fail "unavailable source must be reported"

text="$(PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production "$here/fixtures/results.jsonl")"
grep -q 'VERDICT: SEV1?' <<<"$text" || fail "text verdict missing"
grep -q -- '-- sentry: unavailable' <<<"$text" || fail "text must show the unavailable source"

# No baseline: absolute findings only.
nb="$(PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --no-baseline --json "$here/fixtures/results.jsonl")"
[ "$(jq '.findings | length' <<<"$nb")" = 1 ] || fail "without a baseline only the crashloop should be reported"

# Capture then merge: peak rates and running means.
PH_STATE_ROOT="$state" python3 "$lib/assess.py" --capture --env staging "$here/fixtures/results.jsonl" >/dev/null
PH_STATE_ROOT="$state" python3 "$lib/assess.py" --capture --merge --env staging "$here/fixtures/results.jsonl" >/dev/null
b="$state/staging/baseline.json"
jq -e '.slices == 2 and .rates["http.route:app|/api/public/workflow-session|401"] == 372 and .means["wf.total"] == 440' "$b" >/dev/null \
  || fail "capture/merge produced unexpected rates: $(jq -c '{slices, r: .rates["http.route:app|/api/public/workflow-session|401"], m: .means["wf.total"]}' "$b")"

# Duplicate keys (org namespaces collapsed to org-*) are summed, not overwritten.
dup='{"check":"http","window":"30m","start":"a","end":"b","window_s":1800,"status":"ok","findings":[],"data":{},"notes":[],"series":[
  {"key":"http.route:org-*|GET /x|500","count":200,"title":"t","rules":["new"],"min_new":5},
  {"key":"http.route:org-*|GET /x|500","count":1,"title":"t","rules":["new"],"min_new":5}]}'
c="$(PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --json - <<<"$dup" | jq '.findings[] | select(.key == "http.route:org-*|GET /x|500") | .evidence.count')"
[ "$c" = 201 ] || fail "duplicate series should sum to 201, got $c"

# Nothing found + an unavailable source = incomplete (exit 4), never healthy.
inc='{"check":"k8s","window":"30m","start":"a","end":"b","window_s":1800,"status":"ok","findings":[],"series":[],"notes":[],"data":{}}
{"check":"sentry","window":"30m","start":"a","end":"b","window_s":1800,"status":"unavailable","findings":[],"series":[],"notes":["unavailable: x"],"data":{}}'
set +e
v="$(PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --json --exit-code - <<<"$inc" | jq -r .verdict)"; rc=$?
PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --exit-code - <<<"$inc" >/dev/null; rc=$?
set -e
[ "$v" = incomplete ] && [ "$rc" = 4 ] || fail "expected incomplete/4, got $v/$rc"

# Partial capture: an unavailable check's keys keep their values; ratios are paired.
s2="$state/s2"; mkdir -p "$s2/production"
a='{"check":"workflows","window":"6h","window_s":3600,"status":"ok","findings":[],"notes":[],"data":{},"series":[
  {"key":"wf.total","count":1000,"title":"t"},{"key":"wf.failed","count":100,"title":"t","ratio_of":"wf.total"}]}'
b='{"check":"workflows","window":"6h","window_s":3600,"status":"ok","findings":[],"notes":[],"data":{},"series":[
  {"key":"wf.total","count":100,"title":"t"},{"key":"wf.failed","count":50,"title":"t","ratio_of":"wf.total"}]}'
u='{"check":"workflows","window":"6h","window_s":3600,"status":"unavailable","findings":[],"notes":[],"data":{},"series":[]}'
PH_STATE_ROOT="$s2" python3 "$lib/assess.py" --capture --env production - <<<"$a" >/dev/null
PH_STATE_ROOT="$s2" python3 "$lib/assess.py" --capture --merge --env production - <<<"$b" >/dev/null
PH_STATE_ROOT="$s2" python3 "$lib/assess.py" --capture --merge --env production - <<<"$u" >/dev/null
jq -e '.means["wf.total"] == 550 and .samples["wf.total"] == 2 and .ratios["wf.failed"] == 0.5' "$s2/production/baseline.json" >/dev/null \
  || fail "partial merge or paired ratio wrong: $(jq -c '{m: .means["wf.total"], n: .samples["wf.total"], r: .ratios}' "$s2/production/baseline.json")"
# Replaying the already-baselined 50% slice must not raise a failure-rate finding.
n="$(PH_STATE_ROOT="$s2" python3 "$lib/assess.py" --env production --json - <<<"${b//\"window\":\"6h\"/\"window\":\"6h\",\"start\":\"a\",\"end\":\"b\"}" | jq '[.findings[] | select(.key == "wf.failed")] | length')"
[ "$n" = 0 ] || fail "baselined failure share flagged as a regression"

# Watch state: new, unchanged, escalated, reraise, forgotten; a long-unavailable source.
ws="$state/watch.json"
w1='{"check":"loki-errors","window":"15m","start":"a","end":"b","window_s":900,"status":"ok","series":[],"notes":[],"data":{},"findings":[
  {"hint":"sev3","key":"k.one","title":"one"}]}
{"check":"sentry","window":"15m","start":"a","end":"b","window_s":900,"status":"unavailable","series":[],"findings":[],"notes":["unavailable: token"],"data":{}}'
w2="${w1/\"hint\":\"sev3\"/\"hint\":\"sev2\"}"
watch() {  # watch NOW INPUT -> prints "key=change ..." and the exit status
  local out rc
  set +e; out="$(PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --watch --state "$ws" --now "$1" - <<<"$2")"; rc=$?; set -e
  echo "$(jq -r '[.items[] | "\(.key)=\(.change)"] | join(" ")' <<<"$out") rc=$rc"
}
r="$(watch 2026-10-08T00:05:00Z "$w1")"; [ "$r" = "k.one=new rc=3" ] || fail "first watch run: $r"
r="$(watch 2026-10-08T00:15:00Z "$w1")"; [ "$r" = "k.one=unchanged rc=3" ] || fail "repeat should be unchanged: $r"
r="$(watch 2026-10-08T00:25:00Z "$w2")"; [ "$r" = "k.one=escalated rc=3" ] || fail "sev3 -> sev2 should escalate: $r"
r="$(watch 2026-10-08T01:10:00Z "$w2")"; [ "$r" = "k.one=unchanged source-unavailable:sentry=new rc=3" ] || fail "sentry unavailable an hour should be raised once: $r"
r="$(watch 2026-10-08T01:20:00Z "$w2")"; [ "$r" = "k.one=unchanged source-unavailable:sentry=unchanged rc=3" ] || fail "no second raise: $r"
r="$(watch 2026-10-08T06:30:00Z "$w2")"; [ "$r" = "k.one=reraise source-unavailable:sentry=unchanged rc=3" ] || fail "re-raise after 6h: $r"
jq -e '.keys["k.one"].first_seen == "2026-10-08T00:05:00Z"' "$ws" >/dev/null || fail "first_seen must survive escalation and re-raise"
healthy='{"check":"k8s","window":"15m","start":"a","end":"b","window_s":900,"status":"ok","series":[],"notes":[],"data":{},"findings":[]}'
r="$(watch 2026-10-08T06:40:00Z "$healthy")"; [ "$r" = " rc=0" ] || fail "healthy watch run should print no items and exit 0: $r"
r="$(watch 2026-10-08T13:00:00Z "$w1")"; [ "$r" = "k.one=new source-unavailable:sentry=new rc=3" ] || fail "keys unseen for 6h are new again: $r"
# The full report carries the same marks.
PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --state "$state/other.json" --now 2026-10-08T00:00:00Z - <<<"$w1" | grep -q 'one (new since 2026-10-08T00:00:00Z)' \
  || fail "text report should mark new findings"

# PostHog: an empty window with pageviews earlier in the day is quiet, not broken;
# no pageviews in 24h is a finding and the source is not checked.
bin="$state/bin"; mkdir -p "$bin"
cat >"$bin/curl" <<'SH'
#!/usr/bin/env bash
cat >/dev/null
while [ "$#" -gt 0 ]; do [ "$1" = --data-binary ] && body="$2"; shift; done
case "$body" in
  *"max(timestamp)"*) echo "{\"results\":[[${FAKE_PV24:-0}, \"2026-10-07T21:12:03.5Z\"]]}" ;;
  *countIf*) echo '{"results":[[0,0,0]]}' ;;
  *) echo '{"results":[]}' ;;
esac
SH
chmod +x "$bin/curl"
ph() { PATH="$bin:$PATH" POSTHOG_PERSONAL_API_KEY=x PH_STATE_ROOT="$state" FAKE_PV24="$1" "$here/../scripts/checks/posthog.sh" --raw --window 30m; }
q="$(ph 40)"
jq -e '.status == "ok" and (.findings | length) == 0 and (.data.summary | test("quiet window; last pageview 2026-10-07T21:12:03Z, 40 in 24h"))' <<<"$q" >/dev/null \
  || fail "quiet PostHog window: $(jq -c '{status, findings, s: .data.summary}' <<<"$q")"
q="$(ph 0)"
jq -e '.status == "partial" and .findings[0].key == "posthog.silent" and .findings[0].hint == "sev2"' <<<"$q" >/dev/null \
  || fail "silent PostHog: $(jq -c '{status, findings}' <<<"$q")"

# Normalisation.
[ "$(python3 "$lib/normalise.py" route /lsq3oanefp/w/my-public-app)" = "/:org/w/:id" ] || fail "public app route"
[ "$(python3 "$lib/normalise.py" route '/api/public/workflow-session?sessionId=1')" = "/api/public/workflow-session" ] || fail "query string"
[ "$(python3 "$lib/normalise.py" route /api/sessions/c612b195-5139-493a-b369-5db8bb0a1da8/events)" = "/api/sessions/:id/events" ] || fail "uuid route"
m="$(python3 "$lib/normalise.py" mask 'Run 4d5c887ac8b3 for org-03d41203-8517-4f8e-aced-321e67d9bd45 failed after 300ms, Org=abc123xyz')"
[ "$m" = "Run <hex> for org-<id> failed after Nms, Org=<v>" ] || fail "mask: $m"
# Error lines that start at column zero are kept; continuation lines are not.
sig="$(printf '%s\n' '{"ns":"x","line":"Error: connection refused","strict":true}' '{"ns":"x","line":"panic: runtime error","strict":true}' \
  '{"ns":"x","line":"  at Error: frame","strict":true}' | python3 "$lib/normalise.py" loki-signatures | jq -s length)"
[ "$sig" = 2 ] || fail "strict filter kept $sig of 2 column-zero errors"

# Tracing never prints credentials.
trace="$(CLAUDE_CH_PASSWORD=sentinel-secret-123 bash -x -c ". '$lib/common.sh'; ph_secret CLAUDE_CH_PASSWORD >/dev/null; printf 'user = \"%s\"' \"\$(ph_secret CLAUDE_CH_PASSWORD)\" >/dev/null" 2>&1)"
! grep -q sentinel-secret-123 <<<"$trace" || fail "xtrace leaked a secret"
echo "prod-health tests passed"
