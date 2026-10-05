# shellcheck shell=bash
# Shared helpers for prod-health checks. Source this file; do not execute it.
# Tracing would print credentials as they are expanded, so it is always off here.
{ set +x; } 2>/dev/null
#
# Every check is read-only. Network calls carry timeouts, port-forwards use free
# local ports and are torn down on exit, and secrets are read from the environment
# (with a fish-config fallback) and never printed or written to disk.

PH_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PH_INFRA_DIR="${PH_INFRA_DIR:-$HOME/dev/lleverage-ai/infrastructure}"
PH_STATE_ROOT="${PH_STATE_ROOT:-$HOME/.local/state/prod-health}"
PH_GH_REPO="${PH_GH_REPO:-lleverage-ai/lleverage}"
PH_GH_INFRA_REPO="${PH_GH_INFRA_REPO:-lleverage-ai/infrastructure}"

PH_ENV=production
PH_WINDOW=30m
PH_END=""
PH_RAW=0
PH_JSON=0
PH_ARGS=()

ph_die() { echo "prod-health: $*" >&2; exit 2; }

# Parse the flags every check accepts. Unknown flags are left in PH_ARGS.
ph_parse_common() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env|--window|--end) [ "$#" -ge 2 ] && [ -n "$2" ] || ph_die "$1 needs a value" ;;
    esac
    case "$1" in
      --env) PH_ENV="$2"; shift 2 ;;
      --window) PH_WINDOW="$2"; shift 2 ;;
      --end) PH_END="$2"; shift 2 ;;
      --raw) PH_RAW=1; shift ;;
      --json) PH_JSON=1; shift ;;
      *) PH_ARGS+=("$1"); shift ;;
    esac
  done
  case "$PH_ENV" in production|staging) ;; prod) PH_ENV=production ;; *) ph_die "--env must be production or staging" ;; esac
  PH_WIN_S="$(ph_duration_s "$PH_WINDOW")" || ph_die "bad --window '$PH_WINDOW' (use 30m, 2h, 1d)"
  if [ -n "$PH_END" ]; then
    PH_END_S="$(date -u -d "$PH_END" +%s 2>/dev/null)" || ph_die "bad --end '$PH_END'"
  else
    PH_END_S="$(date -u +%s)"
  fi
  PH_START_S=$(( PH_END_S - PH_WIN_S ))
  PH_END_ISO="$(date -u -d "@$PH_END_S" +%FT%TZ)"
  PH_START_ISO="$(date -u -d "@$PH_START_S" +%FT%TZ)"
  # "Live" means the window ends within five minutes of now; current-state sources
  # (kubectl, Alertmanager) are only meaningful then.
  PH_LIVE=0; [ $(( $(date -u +%s) - PH_END_S )) -lt 300 ] && PH_LIVE=1
  PH_STATE_DIR="$PH_STATE_ROOT/$PH_ENV"
  export KUBECONFIG="$PH_INFRA_DIR/generated/$PH_ENV/kubeconfig"
  ph_tmp >/dev/null; ph_trap_cleanup
  export PH_ENV PH_WINDOW PH_WIN_S PH_END_S PH_START_S PH_END_ISO PH_START_ISO PH_LIVE PH_STATE_DIR
}

ph_duration_s() {
  local v="$1" n u
  [[ "$v" =~ ^([0-9]+)([smhd])$ ]] || return 1
  n="${BASH_REMATCH[1]}"; u="${BASH_REMATCH[2]}"
  case "$u" in s) echo "$n" ;; m) echo $(( n * 60 )) ;; h) echo $(( n * 3600 )) ;; d) echo $(( n * 86400 )) ;; esac
}

ph_kubectl() { kubectl --request-timeout=20s "$@"; }

ph_have_kube() { [ -r "$KUBECONFIG" ] && ph_kubectl version >/dev/null 2>&1; }

ph_free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

PH_TMP=""
ph_tmp() { [ -n "$PH_TMP" ] || PH_TMP="$(mktemp -d "${TMPDIR:-/tmp}/prod-health.XXXXXX")"; echo "$PH_TMP"; }
# Port-forward PIDs go in a file so tunnels opened inside $(...) subshells are
# still cleaned up by the top-level EXIT trap.
ph_cleanup() {
  if [ -n "$PH_TMP" ] && [ -f "$PH_TMP/pf.pids" ]; then
    # shellcheck disable=SC2046
    kill $(cat "$PH_TMP/pf.pids") 2>/dev/null
  fi
  [ -z "$PH_TMP" ] || rm -rf "$PH_TMP"
}
ph_trap_cleanup() { trap ph_cleanup EXIT; trap 'exit 130' INT TERM; }

# ph_port_forward NAMESPACE TARGET REMOTE_PORT -> prints the local port.
# TARGET is svc/NAME or pod/NAME. Waits up to 15s for the port to accept connections.
ph_port_forward() {
  local ns="$1" target="$2" rport="$3" lport log pid i
  lport="$(ph_free_port)" || return 1
  log="$PH_TMP/pf-$lport.log"
  kubectl -n "$ns" port-forward --address 127.0.0.1 "$target" "$lport:$rport" >"$log" 2>&1 &
  pid=$!
  echo "$pid" >>"$PH_TMP/pf.pids"
  for i in $(seq 1 30); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$lport") 2>/dev/null; then echo "$lport"; return 0; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5; : "$i"
  done
  return 1
}

# Shared endpoints. Call the ph_ensure_* functions in the main shell (not inside
# $(...)), so the URL is visible to later calls. The orchestrator exports
# PH_*_URL so every check reuses one tunnel per service.
ph_ensure_loki() {
  [ -n "${PH_LOKI_URL:-}" ] && return 0
  ph_have_kube || return 1
  local p i; p="$(ph_port_forward loki svc/loki 3100)" || return 1
  PH_LOKI_URL="http://127.0.0.1:$p"; export PH_LOKI_URL
  for i in $(seq 1 20); do curl -fs --max-time 2 "$PH_LOKI_URL/ready" >/dev/null 2>&1 && return 0; sleep 0.5; : "$i"; done
  return 0
}
ph_ensure_vm() {
  [ -n "${PH_VM_URL:-}" ] && return 0
  ph_have_kube || return 1
  local p; p="$(ph_port_forward monitoring svc/vmsingle-vm-victoria-metrics-k8s-stack 8428)" || return 1
  PH_VM_URL="http://127.0.0.1:$p"; export PH_VM_URL
}
ph_ensure_am() {
  [ -n "${PH_AM_URL:-}" ] && return 0
  ph_have_kube || return 1
  local p; p="$(ph_port_forward monitoring svc/vmalertmanager-vm-victoria-metrics-k8s-stack 9093)" || return 1
  PH_AM_URL="http://127.0.0.1:$p"; export PH_AM_URL
}

# VictoriaMetrics instant query at the window end. Prints the result array.
ph_vm_query() {
  curl -fsS --max-time 30 "${PH_VM_URL:?call ph_ensure_vm first}/api/v1/query" --data-urlencode "query=$1" --data-urlencode "time=$PH_END_S" \
    | jq -c '.data.result'
}

# Loki instant (metric) query at the window end. Prints the result array.
ph_loki_metric() {
  curl -fsS --max-time 60 -G "${PH_LOKI_URL:?call ph_ensure_loki first}/loki/api/v1/query" --data-urlencode "query=$1" --data-urlencode "time=$PH_END_S" \
    | jq -c '.data.result'
}

# Loki log lines in the window, newest first. Prints JSONL {ns, pod, container, ts, line}.
# Loki caps a query at 5000 lines; callers use the oldest ts to scale counts.
ph_loki_lines() {
  local limit="${2:-2000}"
  curl -fsS --max-time "${3:-90}" -G "${PH_LOKI_URL:?call ph_ensure_loki first}/loki/api/v1/query_range" --data-urlencode "query=$1" \
    --data-urlencode "start=${PH_START_S}000000000" --data-urlencode "end=${PH_END_S}000000000" \
    --data-urlencode "limit=$limit" --data-urlencode "direction=backward" \
    | jq -c '.data.result[] | .stream as $s | .values[] | {ns: ($s.namespace // ""), pod: ($s.pod // ""), container: ($s.container // ""), ts: (.[0][0:10] | tonumber), line: .[1]}'
}

# Read a secret from the environment, falling back to Tom's fish config.
# Prints nothing if unset. Never echo the result.
ph_secret() {
  local name="$1" val="${!1:-}"
  if [ -z "$val" ] && command -v fish >/dev/null 2>&1; then
    val="$(timeout 10 fish -lc "printf %s \"\$$name\"" 2>/dev/null)"
  fi
  printf '%s' "$val"
}

# --- result building ---------------------------------------------------------
# A check accumulates findings, series and notes, then calls ph_emit.
#   finding: an absolute problem (crashloop, critical alert, stuck dispatch).
#   series:  a counted signal compared against the baseline by assess.py.
#   note:    context, including "source unavailable" explanations.
ph_result_init() {
  PH_CHECK="$1"
  PH_FINDINGS="$(ph_tmp)/$PH_CHECK.findings"; : >"$PH_FINDINGS"
  PH_SERIES="$(ph_tmp)/$PH_CHECK.series"; : >"$PH_SERIES"
  PH_NOTES="$(ph_tmp)/$PH_CHECK.notes"; : >"$PH_NOTES"
  PH_DATA="$(ph_tmp)/$PH_CHECK.data"; echo '{}' >"$PH_DATA"
  PH_STATUS=ok
}

# ph_finding HINT KEY TITLE [EVIDENCE_JSON] [NAMESPACE]
# HINT is sev1, sev2 or sev3: the script's suggestion; the agent decides.
ph_finding() {
  jq -nc --arg hint "$1" --arg key "$2" --arg title "$3" --argjson ev "${4:-{\}}" --arg ns "${5:-}" \
    '{hint:$hint, key:$key, title:$title, evidence:$ev} + (if $ns != "" then {namespace:$ns} else {} end)' >>"$PH_FINDINGS"
}

# ph_series KEY COUNT TITLE [OPTIONS_JSON]
# OPTIONS: rules (["new","spike","drop"]), min_new, min_spike, hint, namespace, evidence.
ph_series() {
  jq -nc --arg key "$1" --argjson count "${2:-0}" --arg title "$3" --argjson o "${4:-{\}}" \
    '{key:$key, count:$count, title:$title} + $o' >>"$PH_SERIES"
}

ph_note() { jq -nc --arg t "$*" '$t' >>"$PH_NOTES"; }

# Mark the source (or part of it) unavailable and keep going.
ph_unavailable() { PH_STATUS="${PH_STATUS/ok/partial}"; ph_note "unavailable: $*"; }

ph_data() { local tmp; tmp="$(ph_tmp)/data.$$"; jq -c --arg k "$1" --argjson v "$2" '.[$k] = $v' "$PH_DATA" >"$tmp" && mv "$tmp" "$PH_DATA"; }

ph_emit() {
  local out
  [ "$PH_STATUS" = ok ] && grep -q '^"unavailable: ' "$PH_NOTES" && PH_STATUS=partial
  out="$(jq -nc --arg check "$PH_CHECK" --arg env "$PH_ENV" --arg window "$PH_WINDOW" \
    --arg start "$PH_START_ISO" --arg end "$PH_END_ISO" --arg status "$PH_STATUS" \
    --slurpfile f "$PH_FINDINGS" --slurpfile s "$PH_SERIES" --slurpfile n "$PH_NOTES" --slurpfile d "$PH_DATA" \
    '{check:$check, env:$env, window:$window, start:$start, end:$end, window_s:'"$PH_WIN_S"', status:$status,
      findings:$f, series:$s, notes:$n, data:($d[0] // {})}')"
  if [ "$PH_RAW" = 1 ]; then
    echo "$out"
  else
    local args=(--env "$PH_ENV"); [ "$PH_JSON" = 1 ] && args+=(--json)
    echo "$out" | python3 "$PH_LIB_DIR/assess.py" "${args[@]}" -
  fi
}

# Standard usage for a check: print the header comment of the calling script.
ph_usage() { sed -n '2,/^[^#]/{/^#/s/^# \{0,1\}//p}' "$1"; }

# Unavailable early exit: emit what we have and stop.
ph_bail() { ph_unavailable "$*"; PH_STATUS=unavailable; ph_emit; exit 0; }
