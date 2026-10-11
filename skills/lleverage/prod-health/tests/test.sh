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
jq -e '.verdict == "urgent"' <<<"$report" >/dev/null || fail "verdict should be urgent, got $(jq -r .verdict <<<"$report")"
jq -e '[.findings[].hint] | all(. == "urgent" or . == "high" or . == "medium" or . == "low")' <<<"$report" >/dev/null \
  || fail "hints must use Linear priority names: $(jq -c '[.findings[].hint]' <<<"$report")"
jq -e '.findings[0].key == "wf.category:platform_error"' <<<"$report" >/dev/null || fail "urgent finding should sort first"
jq -e '.findings[] | select(.key == "http.route:app|/api/public/workflow-session|401") | .kind == "spike" and (.candidates[0] | test("#7395"))' <<<"$report" >/dev/null \
  || fail "401 spike should be a spike with the app deploy as first candidate"
jq -e '.findings[] | select(.key | startswith("k8s.waiting")) | .candidates[0] | test("workflow-service")' <<<"$report" >/dev/null \
  || fail "crashloop in an org namespace should point at the workflow-service rollout"
jq -e '.sources.sentry.status == "unavailable"' <<<"$report" >/dev/null || fail "unavailable source must be reported"

text="$(PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production "$here/fixtures/results.jsonl")"
grep -q 'VERDICT: Urgent?' <<<"$text" || fail "text verdict missing"
! grep -qi 'sev[0-9]' <<<"$text" || fail "text report must not say SEVn"

# Output from an older check (sevN hints) is read in the new names.
old='{"check":"k8s","window":"30m","start":"a","end":"b","window_s":1800,"status":"ok","series":[],"notes":[],"data":{},"findings":[
  {"hint":"sev3","key":"k.low","title":"l"},{"hint":"sev1","key":"k.urgent","title":"u"},{"hint":"sev2","key":"k.high","title":"h"}]}'
lr="$(PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --json - <<<"$old")"
jq -e '.verdict == "urgent" and ([.findings[] | "\(.key)=\(.hint)"] | join(" ")) == "k.urgent=urgent k.high=high k.low=low"' <<<"$lr" >/dev/null \
  || fail "legacy hints: $(jq -c '{verdict, f: [.findings[] | {key, hint}]}' <<<"$lr")"
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
  {"hint":"low","key":"k.one","title":"one"}]}
{"check":"sentry","window":"15m","start":"a","end":"b","window_s":900,"status":"unavailable","series":[],"findings":[],"notes":["unavailable: token"],"data":{}}'
w2="${w1/\"hint\":\"low\"/\"hint\":\"high\"}"
watch() {  # watch NOW INPUT -> prints "key=change ..." and the exit status
  local out rc
  set +e; out="$(PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --watch --state "$ws" --now "$1" - <<<"$2")"; rc=$?; set -e
  echo "$(jq -r '[.items[] | "\(.key)=\(.change)"] | join(" ")' <<<"$out") rc=$rc"
}
r="$(watch 2026-10-08T00:05:00Z "$w1")"; [ "$r" = "k.one=new rc=3" ] || fail "first watch run: $r"
r="$(watch 2026-10-08T00:15:00Z "$w1")"; [ "$r" = "k.one=unchanged rc=3" ] || fail "repeat should be unchanged: $r"
r="$(watch 2026-10-08T00:25:00Z "$w2")"; [ "$r" = "k.one=escalated rc=3" ] || fail "low -> high should escalate: $r"
r="$(watch 2026-10-08T01:10:00Z "$w2")"; [ "$r" = "k.one=unchanged source-unavailable:sentry=new rc=3" ] || fail "sentry unavailable an hour should be raised once: $r"
r="$(watch 2026-10-08T01:20:00Z "$w2")"; [ "$r" = "k.one=unchanged source-unavailable:sentry=unchanged rc=3" ] || fail "no second raise: $r"
r="$(watch 2026-10-08T06:30:00Z "$w2")"; [ "$r" = "k.one=reraise source-unavailable:sentry=unchanged rc=3" ] || fail "re-raise after 6h: $r"
jq -e '.keys["k.one"].first_seen == "2026-10-08T00:05:00Z"' "$ws" >/dev/null || fail "first_seen must survive escalation and re-raise"
# Watcher contract: findings == items, each with status (== change), first_seen and
# last_raised; per-source status with notes for the sources that weren't ok.
set +e; out="$(PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --watch --state "$ws" --now 2026-10-08T06:35:00Z - <<<"$w2")"; set -e
jq -e '.findings == .items and (.findings[] | select(.key == "k.one") | .status == "unchanged" and .first_seen == "2026-10-08T00:05:00Z"
       and .last_raised == "2026-10-08T06:30:00Z" and .severity == "high" and (.summary | test("one")))
       and .sources.sentry == "unavailable" and (.source_notes.sentry[0] | test("token")) and (.source_notes | has("loki-errors") | not)' <<<"$out" >/dev/null \
  || fail "watch contract fields: $(jq -c '{findings, sources, source_notes}' <<<"$out")"
healthy='{"check":"k8s","window":"15m","start":"a","end":"b","window_s":900,"status":"ok","series":[],"notes":[],"data":{},"findings":[]}'
r="$(watch 2026-10-08T06:40:00Z "$healthy")"; [ "$r" = " rc=0" ] || fail "healthy watch run should print no items and exit 0: $r"
r="$(watch 2026-10-08T13:00:00Z "$w1")"; [ "$r" = "k.one=new source-unavailable:sentry=new rc=3" ] || fail "keys unseen for 6h are new again: $r"
# The full report carries the same marks.
PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --state "$state/other.json" --now 2026-10-08T00:00:00Z - <<<"$w1" | grep -q 'one (new since 2026-10-08T00:00:00Z)' \
  || fail "text report should mark new findings"

# Watch state written before the rename (sevN severities) keeps working: the same
# finding in the new names is unchanged, not new or escalated, and a real
# escalation is still caught. The stored values are rewritten in the new names.
legacy="$state/legacy-watch.json"
cat >"$legacy" <<'JSON'
{"version": 1, "updated_at": "2026-10-12T09:00:00Z", "sources": {}, "keys": {
  "k.high": {"first_seen": "2026-10-12T08:00:00Z", "announced_at": "2026-10-12T08:00:00Z", "announced_severity": "sev2",
             "last_seen": "2026-10-12T09:00:00Z", "severity": "sev2", "summary": "x"},
  "k.low": {"first_seen": "2026-10-12T08:00:00Z", "announced_at": "2026-10-12T08:00:00Z", "announced_severity": "sev3",
            "last_seen": "2026-10-12T09:00:00Z", "severity": "sev3", "summary": "x"},
  "k.urgent": {"first_seen": "2026-10-12T08:00:00Z", "announced_at": "2026-10-12T08:00:00Z", "announced_severity": "sev1",
               "last_seen": "2026-10-12T09:00:00Z", "severity": "sev1", "summary": "x"},
  "k.worse": {"first_seen": "2026-10-12T08:00:00Z", "announced_at": "2026-10-12T08:00:00Z", "announced_severity": "sev3",
              "last_seen": "2026-10-12T09:00:00Z", "severity": "sev3", "summary": "x"}}}
JSON
lw='{"check":"k8s","window":"15m","start":"a","end":"b","window_s":900,"status":"ok","series":[],"notes":[],"data":{},"findings":[
  {"hint":"urgent","key":"k.urgent","title":"u"},{"hint":"high","key":"k.high","title":"h"},
  {"hint":"low","key":"k.low","title":"l"},{"hint":"high","key":"k.worse","title":"w"}]}'
set +e; out="$(PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --watch --state "$legacy" --now 2026-10-12T09:15:00Z - <<<"$lw")"; set -e
r="$(jq -r '[.items[] | "\(.key)=\(.status)"] | sort | join(" ")' <<<"$out")"
[ "$r" = "k.high=unchanged k.low=unchanged k.urgent=unchanged k.worse=escalated" ] \
  || fail "legacy watch state should map sev1/2/3 to urgent/high/low: $r"
jq -e '.raise_count == 1' <<<"$out" >/dev/null || fail "only the real escalation should be raised: $(jq -c .raise_count <<<"$out")"
jq -e '[.keys[] | .severity, .announced_severity] | all(test("^(urgent|high|medium|low)$"))' "$legacy" >/dev/null \
  || fail "legacy state should be rewritten in the new names: $(jq -c .keys "$legacy")"

# PostHog: a zero is never "ok". An empty window with pageviews earlier in the day
# is quiet but unconfirmed (partial); no pageviews for 2h of working hours is a
# low posthog.silent, and none in 24h a high one (same key, so it escalates).
bin="$state/bin"; mkdir -p "$bin"
cat >"$bin/curl" <<'SH'
#!/usr/bin/env bash
cat >/dev/null
while [ "$#" -gt 0 ]; do [ "$1" = --data-binary ] && body="$2"; shift; done
case "$body" in
  *"max(timestamp)"*) echo "{\"results\":[[${FAKE_PV24:-0}, \"2026-10-07T21:12:03.5Z\", ${FAKE_PV2H:-0}]]}" ;;
  *countIf*) echo "{\"results\":${FAKE_VOL:-[[0,0,0]]}}" ;;
  *"GROUP BY t, m, p"*) echo "{\"results\":${FAKE_ROWS:-[]}}" ;;
  *) echo '{"results":[]}' ;;
esac
SH
chmod +x "$bin/curl"
ph() {  # ph PV24 PV2H END
  PATH="$bin:$PATH" POSTHOG_PERSONAL_API_KEY=x PH_STATE_ROOT="$state" FAKE_PV24="$1" FAKE_PV2H="$2" \
    "$here/../scripts/checks/posthog.sh" --raw --window 30m --end "$3"
}
# 8 Oct 2026 01:46 CEST: the night the check reported 0 pageviews as ok.
q="$(ph 40 0 2026-10-07T23:46:46Z)"
jq -e '.status == "partial" and (.findings | length) == 0 and (.data.summary | test("quiet window; last pageview 2026-10-07T21:12:03Z, 40 in 24h"))
       and any(.notes[]; test("browser health can.t be confirmed"))' <<<"$q" >/dev/null \
  || fail "quiet PostHog window must be partial, not ok: $(jq -c '{status, findings, notes, s: .data.summary}' <<<"$q")"
# Thursday 8 Oct 14:00 CEST, nothing for 2h: a low silence.
q="$(ph 40 0 2026-10-08T12:00:00Z)"
jq -e '.status == "partial" and .findings[0].key == "posthog.silent" and .findings[0].hint == "low" and .findings[0].evidence.lookback == "2h"' <<<"$q" >/dev/null \
  || fail "working-hours PostHog silence: $(jq -c '{status, findings}' <<<"$q")"
# Same time with traffic in the last 2h but none in the window: quiet, no finding.
q="$(ph 40 7 2026-10-08T12:00:00Z)"
jq -e '.status == "partial" and (.findings | length) == 0' <<<"$q" >/dev/null || fail "working-hours quiet window: $(jq -c '{status, findings}' <<<"$q")"
# Saturday afternoon, nothing for 2h: quiet, not a finding.
q="$(ph 40 0 2026-10-10T12:00:00Z)"
jq -e '(.findings | length) == 0' <<<"$q" >/dev/null || fail "weekend 2h silence should not be a finding: $(jq -c '{findings}' <<<"$q")"
q="$(ph 0 0 2026-10-07T23:46:46Z)"
jq -e '.status == "partial" and .findings[0].key == "posthog.silent" and .findings[0].hint == "high"' <<<"$q" >/dev/null \
  || fail "silent PostHog: $(jq -c '{status, findings}' <<<"$q")"
# 12 Oct 2026: one user's ResizeObserver loop held posthog.exceptions at ~7x for
# hours. Signatures matching a noise pattern stay in the per-signature series but
# are left out of the total, and the excluded count is reported next to it.
export FAKE_VOL='[[40,23,3]]' FAKE_ROWS='[["Error","ResizeObserver loop completed with undelivered notifications.","/lsq3oanefp/projects/oy7cot4w/workflows/wrk-1",15,1],
  ["Error","ResizeObserver loop limit exceeded","/abc1234/agent",3,1],["TypeError","Cannot read properties of null (reading 0)","/abc1234/agent",5,2]]'
noisecheck() {  # noisecheck WHAT: total 5 of 23, 18 excluded, RO series still emitted
  jq -e '(.series[] | select(.key == "posthog.exceptions") | .count == 5 and .evidence == {all_exceptions: 23, excluded_noise: 18})
    and .data.exceptions == {all: 23, excluded_noise: 18, counted: 5} and (.data.summary | test("5 browser exceptions plus 18 known noise"))
    and ([.series[] | select(.key | startswith("posthog.exc:Error|ResizeObserver loop"))] | length) == 2' <<<"$2" >/dev/null \
    || fail "$1: $(jq -c '{s: .series, d: .data}' <<<"$2")"
}
jq '.noise = [{"pattern": "posthog.exc:Error|ResizeObserver loop*"}]' "$here/fixtures/baseline.json" >"$state/production/baseline.json"
noisecheck "baseline noise left out of the total" "$(ph 40 7 2026-10-12T13:25:00Z)"
rm "$state/production/baseline.json"   # no baseline yet: the seed list applies
noisecheck "seed noise left out of the total" "$(ph 40 7 2026-10-12T13:25:00Z)"
cp "$here/fixtures/baseline.json" "$state/production/baseline.json"   # its noise list has no PostHog pattern
q="$(ph 40 7 2026-10-12T13:25:00Z)"
jq -e '.data.exceptions == {all: 23, excluded_noise: 0, counted: 23}' <<<"$q" >/dev/null || fail "no matching pattern: $(jq -c .data <<<"$q")"
unset FAKE_VOL FAKE_ROWS

# k8s live pods: a pod that a rolling update is draining fails readiness on purpose
# and is skipped; one still present >5m after its grace period is stuck-terminating;
# an ordinary pod not ready for >5m is still k8s.notready.
kbin="$state/kbin"; mkdir -p "$kbin" "$state/infra/generated/production"; : >"$state/infra/generated/production/kubeconfig"
now="$(date -u +%s)"; at() { date -u -d "@$(( now + $1 ))" +%FT%TZ; }
pod() {  # pod NS NAME READY_SINCE_S [DELETION_S GRACE_S]
  jq -nc --arg ns "$1" --arg name "$2" --arg created "$(at -7200)" --arg since "$(at "$3")" \
    --arg del "${4:+$(at "${4:-0}")}" --argjson grace "${5:-null}" '
    {metadata: ({namespace: $ns, name: $name, creationTimestamp: $created,
                 ownerReferences: [{kind: "ReplicaSet", name: "x"}]}
                + (if $del != "" then {deletionTimestamp: $del, deletionGracePeriodSeconds: $grace} else {} end)),
     spec: {nodeName: "node-1", terminationGracePeriodSeconds: ($grace // 30)},
     status: {phase: "Running", conditions: [{type: "Ready", status: "False", reason: "ContainersNotReady", lastTransitionTime: $since}],
              containerStatuses: [{name: "service", ready: false, state: {running: {}}}]}}'
}
{
  # Deleted 10m ago with a 2100 s grace period: draining, deadline 25m away.
  pod agent-service agent-service-deployment-ff447cc49-vjxzq -600 1500 2100
  # Grace period ended 2m ago: within the 5m allowance, still skipped.
  pod org-aaaa workflow-deployment-6d8f7b9c5d-abcde -540 -120 420
  # Grace period ended 20m ago: stuck in Terminating.
  pod org-bbbb workflow-deployment-6d8f7b9c5d-fghij -1620 -1200 420
  # Not terminating, not ready for 10m: a real not-ready pod.
  pod credential-service credential-service-deployment-7c9d8f6b5-klmno -600
} | jq -sc '{items: .}' >"$state/pods.json"
cat >"$kbin/kubectl" <<'SH'
#!/usr/bin/env bash
case " $* " in
  *" version "*) exit 0 ;;
  *" get pods "*) cat "$FAKE_PODS" ;;
  *" get deploy "*) if [ -n "${FAKE_DEPS:-}" ]; then cat "$FAKE_DEPS"; else echo '{"items":[]}'; fi ;;
  *" get rollouts"*) echo '{"items":[]}' ;;
  *) exit 1 ;;
esac
SH
chmod +x "$kbin/kubectl"
k="$(PATH="$kbin:$PATH" PH_INFRA_DIR="$state/infra" FAKE_PODS="$state/pods.json" "$here/../scripts/checks/k8s.sh" --raw --window 30m)"
kk="$(jq -r '[.findings[].key] | sort | join(" ")' <<<"$k")"
[ "$kk" = "k8s.notready:credential-service/credential-service-deployment k8s.stuck-terminating:org-*/workflow-deployment" ] \
  || fail "k8s terminating pods: expected notready for credential-service and stuck-terminating for org-bbbb only; got: $kk"
jq -e '.findings[] | select(.key == "k8s.stuck-terminating:org-*/workflow-deployment") | .hint == "low" and .namespace == "org-bbbb"
       and .evidence.pods[0].pod == "workflow-deployment-6d8f7b9c5d-fghij" and .evidence.pods[0].grace_s == 420 and (.title | test("20m after"))' <<<"$k" >/dev/null \
  || fail "stuck-terminating finding: $(jq -c '.findings' <<<"$k")"
jq -e '.findings[] | select(.key == "k8s.notready:credential-service/credential-service-deployment") | .hint == "high"' <<<"$k" >/dev/null \
  || fail "core-namespace not-ready pod should stay high: $(jq -c '.findings' <<<"$k")"
jq -e 'any(.notes[]; test("^2 pod\\(s\\) terminating within their grace period"))' <<<"$k" >/dev/null \
  || fail "skipped terminating pods should be counted in a note: $(jq -c '.notes' <<<"$k")"

# k8s deployments: Progressing's lastUpdateTime is the end of the last rollout, and HPA
# scaling or a readiness flap never moves it. Once the rollout is complete a shortfall
# is timed from Available going False, so a scale-up caught mid-flight or a brief flap
# is no finding (TASK-0221, TASK-0639, TASK-1185); a stalled rollout is still
# rollout-stuck, and a shortfall that lasts after a complete rollout is
# replicas-unavailable, high at most.
dep() {  # dep NS NAME WANT PODS UPDATED AVAIL REASON PROGRESSED_S AVAILABLE AVAILABLE_SINCE_S
  jq -nc --arg ns "$1" --arg name "$2" --argjson want "$3" --argjson pods "$4" --argjson upd "$5" --argjson avail "$6" \
    --arg reason "$7" --arg prog "$(at "$8")" --arg av "$9" --arg avsince "$(at "${10}")" --arg created "$(at -864000)" '
    {metadata: {namespace: $ns, name: $name, generation: 7, creationTimestamp: $created},
     spec: {replicas: $want, template: {spec: {containers: [{image: "r/\($name):abc"}]}}},
     status: {observedGeneration: 7, replicas: $pods, updatedReplicas: $upd, readyReplicas: $avail, availableReplicas: $avail,
              conditions: [{type: "Available", status: $av, lastTransitionTime: $avsince, lastUpdateTime: $avsince},
                           {type: "Progressing", status: "True", reason: $reason, lastUpdateTime: $prog, lastTransitionTime: $prog}]}}'
}
{
  # TASK-1185: the HPA's 8th pod, 1 s old; the rollout ended 28m ago.
  dep session-service session-service-deployment 8 8 8 7 NewReplicaSetAvailable -1731 False -1
  # The same scale-up before the ReplicaSet has created the pod.
  dep agent-service agent-service-deployment 8 7 7 7 NewReplicaSetAvailable -1731 False -1
  # A single-replica org deployment whose pod failed readiness a minute ago.
  dep org-cccc workflow-deployment 1 1 1 0 NewReplicaSetAvailable -3600 False -60
  # A flap within maxUnavailable: Available stays True (its pod is k8s.notready's job).
  dep app app-deployment 4 4 4 3 NewReplicaSetAvailable -3600 True -86400
  # A rollout stalled for 20m with an old pod still serving.
  dep workflow-service workflow-service-deployment 3 4 1 3 ReplicaSetUpdated -1200 True -86400
  # Rollout done 2h ago, one replica unavailable for 25m.
  dep data-service data-service-deployment 2 2 2 1 NewReplicaSetAvailable -7200 False -1500
} | jq -sc '{items: .}' >"$state/deps.json"
echo '{"items":[]}' >"$state/nopods.json"
k="$(PATH="$kbin:$PATH" PH_INFRA_DIR="$state/infra" FAKE_PODS="$state/nopods.json" FAKE_DEPS="$state/deps.json" "$here/../scripts/checks/k8s.sh" --raw --window 30m)"
kk="$(jq -r '[.findings[] | "\(.key)=\(.hint)"] | sort | join(" ")' <<<"$k")"
[ "$kk" = "k8s.replicas-unavailable:data-service/data-service-deployment=high k8s.rollout-stuck:workflow-service/workflow-service-deployment=urgent" ] \
  || fail "k8s deployments: expected only the stalled rollout (urgent) and the sustained shortfall (high); got: $kk"
jq -e '.findings[] | select(.key | startswith("k8s.replicas-unavailable")) | .title | test("1/2 available, 2 updated, for 25m")' <<<"$k" >/dev/null \
  || fail "replicas-unavailable should be timed from Available going False: $(jq -c '.findings' <<<"$k")"
jq -e '.findings[] | select(.key | startswith("k8s.rollout-stuck")) | .title | test("1/3 updated, 3 available, ReplicaSetUpdated for 20m")' <<<"$k" >/dev/null \
  || fail "rollout-stuck should still be timed from Progressing: $(jq -c '.findings' <<<"$k")"
[ "$(jq '[.notes[] | select(startswith("scaling: "))] | length' <<<"$k")" = 4 ] \
  || fail "scale-ups and flaps should be notes: $(jq -c '.notes' <<<"$k")"

# Loki signatures: the per-namespace unlabelled samples are fetched in parallel.
# On 20 Oct 2026 their concurrent appends to one shared file spliced long lines
# together, so app's "Cache fetch failed" lines were counted under
# notification-service and raised a false new signature (TASK-2029). Each sample
# here is long JSON whose message comes last, so a spliced record would pair one
# namespace with another's message.
lbin="$state/lbin"; ldata="$state/loki"; mkdir -p "$lbin" "$ldata"
lns=(alpha bravo charlie delta echo foxtrot golf hotel)
pad="$(head -c 6000 /dev/zero | tr '\0' x)"
for ns in "${lns[@]}"; do
  python3 - "$ns" "$pad" >"$ldata/$ns.json" <<'PY'
import json, sys
ns, pad = sys.argv[1], sys.argv[2]
line = json.dumps({"pad": pad, "message": f"Error: cache fetch failed in {ns}"})
vals = [[str(1792486800 - i) + "000000000", line] for i in range(200)]
print(json.dumps({"data": {"result": [{"stream": {"namespace": ns, "pod": f"{ns}-pod", "container": "service"}, "values": vals}]}}))
PY
done
jq -nc --args '{data: {result: [$ARGS.positional[] | {metric: {namespace: .}, value: [0, "200"]}]}}' "${lns[@]}" >"$ldata/volume.json"
cat >"$lbin/curl" <<'SH'
#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do case "$1" in http*) url="$1" ;; query=*) q="${1#query=}" ;; esac; shift; done
empty='{"data":{"result":[]}}'
case "$url" in
  */query_range) [[ "$q" =~ namespace=\"([a-z]+)\" ]] && cat "$FAKE_LOKI/${BASH_REMATCH[1]}.json" || echo "$empty" ;;
  */query) if [[ "$q" == *'level=""'* ]]; then cat "$FAKE_LOKI/volume.json"; else echo "$empty"; fi ;;
  *) exit 22 ;;
esac
SH
chmod +x "$lbin/curl"
for run in 1 2; do
  l="$(PATH="$lbin:$PATH" PH_LOKI_URL=http://loki.invalid FAKE_LOKI="$ldata" \
    "$here/../scripts/checks/loki-errors.sh" --raw --end 2026-10-20T09:00:00Z --window 15m)"
  jq -e --argjson n "${#lns[@]}" '[.series[] | select(.key | startswith("loki.sig:"))] as $s
      | ($s | length) == $n and all($s[]; .namespace as $ns | .count == 200 and (.evidence.namespaces | keys) == [$ns]
        and (.evidence.sample | endswith(" in \($ns)")) and (.key | endswith(" in \($ns)")))
      and (.data.summary | endswith("\($n) signatures from \($n * 200) lines"))' <<<"$l" >/dev/null \
    || fail "loki signatures mixed namespaces (run $run): $(jq -c '{s: [.series[] | select(.key | startswith("loki.sig:")) | {key, count, ns: .evidence.namespaces}], sum: .data.summary}' <<<"$l" | head -c 2000)"
done

# HTTP routes: a status with no path and no method isn't a request (agent-sandbox-service
# "Retrying Kubernetes API operation" 409s, agent-service metadata-lookup 404s) and makes
# no route key; real requests to / still do. Loki and kubectl are stubbed.
hbin="$state/hbin"; infra="$state/infra"; mkdir -p "$hbin" "$infra/generated/production"; : >"$infra/generated/production/kubeconfig"
printf '#!/usr/bin/env bash\nexit 0\n' >"$hbin/kubectl"
cat >"$hbin/curl" <<SH
#!/usr/bin/env bash
q=""; for a in "\$@"; do case "\$a" in query=*) q="\$a" ;; esac; done
case "\$q" in
  *"| json method="*) cat "$here/fixtures/http-loki-json.json" ;;
  *"| regexp "*) cat "$here/fixtures/http-loki-access.json" ;;
  *) echo '{"data":{"result":[]}}' ;;
esac
SH
chmod +x "$hbin/kubectl" "$hbin/curl"
http="$(PATH="$hbin:$PATH" PH_INFRA_DIR="$infra" PH_STATE_ROOT="$state" PH_LOKI_URL=http://loki.invalid PH_VM_URL=http://vm.invalid \
  "$here/../scripts/checks/http.sh" --raw --window 2h --end 2026-10-11T20:20:00Z)"
hk="$(jq -r '.series[] | "\(.key)=\(.count)"' <<<"$http" | sort | tr '\n' ' ')"
[ "$hk" = 'http.route:actions-gateway|POST /|400=2 http.route:app|POST /api/public/workflow-session|401=12 http.route:credential-service|GET /|404=52 http.route:example-api|POST /|409=25 http.route:example-api|PUT /|409=21 ' ] \
  || fail "http route keys: $hk"
jq -e '.data.http_skipped_no_path == 791' <<<"$http" >/dev/null || fail "pathless non-request lines should be counted as skipped: $(jq -c .data <<<"$http")"
jq -e '.series[] | select(.key == "http.route:example-api|POST /|409") | .evidence.query == "{namespace=\"example-api\"} |~ `\"(status|statusCode)\":\\s*\"?409\\b|\" 409 `"' <<<"$http" >/dev/null \
  || fail "evidence query for / should match the status field: $(jq -c '[.series[].evidence.query]' <<<"$http")"
jq -e '.series[] | select(.key == "http.route:app|POST /api/public/workflow-session|401") | .evidence.query | startswith("{namespace=\"app\"} |= \"/api/public/workflow-session\" |~ ")' <<<"$http" >/dev/null \
  || fail "evidence query should keep the route prefix: $(jq -c '[.series[].evidence.query]' <<<"$http")"
hf="$(PH_STATE_ROOT="$state" python3 "$lib/assess.py" --env production --json - <<<"$http" | jq -r '.findings[].key')"
for k in 'http.route:example-api|POST /|409' 'http.route:example-api|PUT /|409'; do
  grep -qxF "$k" <<<"$hf" || fail "a real 409 on / should still raise $k; got: $hf"
done
! grep -q '|/|' <<<"$hf" || fail "no route key without a method should be raised: $hf"

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

# Ad-hoc query guard (dry run: nothing is sent). Unsafe shapes exit 3 with the safe shape;
# safe ones exit 0 with the plan.
q="$here/../scripts/query.sh"
refused() { local want="$1" err rc=0; shift
  err="$("$q" "$@" --dry-run 2>&1 >/dev/null)" || rc=$?
  [ "$rc" = 3 ] || fail "expected refusal (exit 3, got $rc) for: $*"
  grep -q -- "$want" <<<"$err" || fail "refusal for '$*' should mention '$want': $err"
  grep -q 'safe shape:' <<<"$err" || fail "refusal for '$*' gives no safe shape"; }
allowed() { local want="$1" out; shift
  out="$("$q" "$@" --dry-run)" || fail "expected '$*' to pass the guard"
  jq -e "$want" <<<"$out" >/dev/null || fail "plan for '$*' doesn't match $want: $out"; }
m=agent_sandbox_runner_output_sync_consecutive_failures
refused 'range query over 5d' vm "max by (pod)($m) >= 3" --range 5d --step 60   # the LLE-16077 query
refused 'by (pod) on a 5d window' vm "max by (pod)(max_over_time(${m}[5d])) >= 3"
refused 'by (instance) on a 2d window' vm "max(max_over_time(${m}[2d])) by (instance)"
refused 'without aggregation' vm "max_over_time(${m}[5d]) >= 3"
refused 'without (...)' vm 'sum without (le) (rate(foo_bucket[2d]))'
refused '5760 points' vm 'sum(up)' --range 24h --step 15s
refused 'subquery makes 7200 points' vm 'max(max_over_time(rate(foo[5m])[5d:1m]))'
refused 'no metric name' vm 'sum({namespace="app"})'
refused '__name__=~' vm 'sum({__name__=~"agent_.*"})'
refused 'limit is 7d' vm 'max(max_over_time(up[30d]))'
# shellcheck disable=SC2016 # a literal Grafana variable
refused "can't read the range" vm 'sum(rate(up[$__rate_interval]))'
refused 'limit is 24h (LLE-15393' loki 'sum(count_over_time({namespace="app"}[1790640242s]))'
refused 'a 3d query range' loki '{namespace="app"} |= "error"' --range 3d
refused "doesn't narrow anything" loki '{namespace=~".+"} |= "OOM"'
refused "doesn't narrow anything" loki '{job="loki.source.kubernetes.pod_logs"}'
refused 'narrowed only by a regex' loki 'sum(count_over_time({namespace=~"org-.*"} |= "x" [24h]))'
refused '--limit 20000' loki '{namespace="app"}' --limit 20000
allowed '.mode == "instant" and .window_s == 432000' vm "count(max_over_time(${m}[5d]) >= 3)"
allowed '.mode == "instant"' vm "topk(10, max_over_time(${m}[5d]))"
allowed '.mode == "instant"' vm 'histogram_quantile(0.99, sum by (le) (rate(http_duration_seconds_bucket{job="x", code=~"5.."}[3d])))'
allowed '.mode == "range" and .step_s == 240' vm "max by (pod)($m)" --range 24h
allowed '.mode == "logs" and .limit == 50 and .path == "/loki/api/v1/query_range"' \
  loki '{namespace="app"} |= "error" | json | line_format "{{.msg}}"' --range 30m --limit 50
allowed '.mode == "instant" and .window_s == 86400' \
  loki 'sum(count_over_time({namespace=~"org-.*", container="workflow-service"} |= "x" [24h]))'
allowed '.mode == "range" and .step_s == 60' loki 'sum by (namespace) (count_over_time({namespace="app"} [5m]))' --range 6h

# Tracing never prints credentials.
trace="$(CLAUDE_CH_PASSWORD=sentinel-secret-123 bash -x -c ". '$lib/common.sh'; ph_secret CLAUDE_CH_PASSWORD >/dev/null; printf 'user = \"%s\"' \"\$(ph_secret CLAUDE_CH_PASSWORD)\" >/dev/null" 2>&1)"
! grep -q sentinel-secret-123 <<<"$trace" || fail "xtrace leaked a secret"
echo "prod-health tests passed"
