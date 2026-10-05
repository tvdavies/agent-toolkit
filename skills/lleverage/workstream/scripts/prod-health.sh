#!/usr/bin/env bash
# Read-only health snapshot of an environment: firing alerts, error/warn volume by
# namespace, and pods that are not running or restarted inside the window.
# Usage: prod-health.sh [--env production|staging] [--window 30m] [--extra FILE]
#   --extra FILE  a workstream-specific bash snippet sourced at the end. It can use
#                 $LOKI (logcli base command with --since), $KUBECONFIG and $WIN.
# Compare the output with the workstream's baseline before calling anything a regression.
set -uo pipefail

env=production; WIN=30m; extra=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) env="$2"; shift 2 ;;
    --window) WIN="$2"; shift 2 ;;
    --extra) extra="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) WIN="$1"; shift ;;
  esac
done

export KUBECONFIG="/home/tvd/dev/lleverage-ai/infrastructure/generated/$env/kubeconfig"
[ -r "$KUBECONFIG" ] || { echo "prod-health: no kubeconfig at $KUBECONFIG" >&2; exit 2; }

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
LP="$(free_port)"; AP="$(free_port)"
log="$(mktemp -d)"
kubectl -n loki port-forward --address 127.0.0.1 svc/loki "$LP:3100" >"$log/loki.log" 2>&1 & PF1=$!
kubectl -n monitoring port-forward --address 127.0.0.1 svc/vmalertmanager-vm-victoria-metrics-k8s-stack "$AP:9093" >"$log/am.log" 2>&1 & PF2=$!
trap 'kill $PF1 $PF2 2>/dev/null; rm -rf "$log"' EXIT
for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$LP/ready" >/dev/null 2>&1 && break; sleep 0.5; done

LOKI="logcli --addr=http://127.0.0.1:$LP query --quiet --output=raw --since=$WIN"
echo "== $(date -u +%FT%TZ) env=$env window=$WIN"

echo "-- firing alerts"
curl -fs "http://127.0.0.1:$AP/api/v2/alerts?active=true&silenced=false&inhibited=false" \
  | jq -r '.[] | "\(.labels.severity // "-")\t\(.labels.alertname)\t\(.labels.namespace // "")"' \
  | sort | uniq -c | sort -rn | head -30 || echo "(alertmanager unreachable)"

for lvl in error warn; do
  echo "-- level=$lvl by namespace (top 12)"
  logcli --addr="http://127.0.0.1:$LP" instant-query --quiet --output=jsonl \
    "topk(12, sum by (namespace) (count_over_time({job=\"loki.source.kubernetes.pod_logs\", level=~\"(?i)$lvl.*\"}[$WIN])))" 2>/dev/null \
    | jq -r '.. | objects | select(has("metric")) | "\(.value[1] // .value)\t\(.metric.namespace)"' 2>/dev/null | sort -rn
done

echo "-- pods not Running/Succeeded, or restarted inside the window"
secs="$(echo "$WIN" | awk '/m$/{print $0*60} /h$/{print $0*3600} /s$/{print $0+0}')"
kubectl get pods -A -o json 2>/dev/null | jq -r --argjson now "$(date -u +%s)" --argjson w "${secs:-1800}" '
  .items[] | . as $p
  | ([.status.containerStatuses[]? | select(.lastState.terminated.finishedAt != null)
      | select($now - (.lastState.terminated.finishedAt | fromdateiso8601) < $w)
      | "\(.name):\(.lastState.terminated.reason)"] | join(",")) as $recent
  | select(($p.status.phase != "Running" and $p.status.phase != "Succeeded") or $recent != "")
  | "\($p.metadata.namespace)/\($p.metadata.name)\t\($p.status.phase)\t\($recent)"' | head -40

if [ -n "$extra" ]; then
  echo "-- workstream checks ($extra)"
  # shellcheck disable=SC1090
  . "$extra"
fi
