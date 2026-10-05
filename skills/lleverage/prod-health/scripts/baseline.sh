#!/usr/bin/env bash
# Manage prod-health baselines in ~/.local/state/prod-health/<env>/baseline.json.
# Usage: baseline.sh COMMAND [--env production|staging] [options]
#   capture [--window 6h] [--slices 4] [--merge]
#                                     run all checks over SLICES consecutive windows ending
#                                     now (4 x 6h = the last day) and store per-hour rates:
#                                     the peak per key (spikes) and the mean (drops).
#                                     --merge folds into the existing baseline instead.
#                                     --end ISO anchors the slices at a past time instead.
#   seed [--window 6h] [--slices 4]   capture, then add the seeded known-noise patterns
#   show                              summary of the stored baseline
#   accept KEY [--note TEXT]          a human confirmed a finding is normal: raise the
#                                     baseline rate for KEY to what the last run saw
#   noise add PATTERN --note TEXT     always ignore findings whose key matches PATTERN (glob)
#   noise rm PATTERN | noise list
# Keys and patterns are the finding keys shown by prod-health.sh --json.
set -uo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
STATE_ROOT="${PH_STATE_ROOT:-$HOME/.local/state/prod-health}"
cmd="${1:-}"; [ "$#" -gt 0 ] && shift
env=production; window=6h; slices=4; merge=0; note=""; end=""; args=(); rest=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) env="$2"; shift 2 ;;
    --window) window="$2"; shift 2 ;;
    --merge) merge=1; shift ;;
    --slices) slices="$2"; shift 2 ;;
    --note) note="$2"; shift 2 ;;
    --end) end="$2"; shift 2 ;;
    --only|--skip|--timeout) args+=("$1" "$2"); shift 2 ;;
    -h|--help) cmd=help; shift ;;
    *) rest+=("$1"); shift ;;
  esac
done
[ "$env" = prod ] && env=production
dir="$STATE_ROOT/$env"; file="$dir/baseline.json"
mkdir -p "$dir"; chmod 700 "$STATE_ROOT" "$dir" 2>/dev/null
now() { date -u +%FT%TZ; }
edit() {   # edit JQ_FILTER [jq args...]: atomic in-place update of the baseline
  local f="$1"; shift
  [ -s "$file" ] || echo '{"rates":{},"presence":[],"noise":[],"history":[]}' >"$file"
  jq "$@" "$f" "$file" >"$file.tmp" && mv "$file.tmp" "$file"
}

# jq filters below are single-quoted on purpose.
# shellcheck disable=SC2016
case "$cmd" in
  capture|seed)
    res="$(mktemp)"; trap 'rm -f "$res"' EXIT
    win_s="$(python3 -c 'import re,sys; m=re.fullmatch(r"(\d+)([smhd])", sys.argv[1]); print(int(m[1]) * {"s":1,"m":60,"h":3600,"d":86400}[m[2]])' "$window")" \
      || { echo "bad --window" >&2; exit 2; }
    end_s="$(date -u -d "${end:-now}" +%s)" || { echo "bad --end" >&2; exit 2; }
    for i in $(seq 1 "$slices"); do
      end_iso="$(date -u -d "@$(( end_s - (i - 1) * win_s ))" +%FT%TZ)"
      echo "slice $i/$slices: $window ending $end_iso (all checks, read-only)..." >&2
      "$HERE/prod-health.sh" --env "$env" --window "$window" --end "$end_iso" --results --timeout 240 "${args[@]+"${args[@]}"}" >"$res"
      jq -r '"  \(.check): \(.status)\(if .status != "ok" then " " + (.notes | map(select(startswith("unavailable"))) | join("; ")) else "" end)"' "$res" >&2
      margs=(--capture --env "$env" --baseline "$file"); { [ "$merge" = 1 ] || [ "$i" -gt 1 ]; } && margs+=(--merge)
      python3 "$HERE/lib/assess.py" "${margs[@]}" "$res"
    done
    if [ "$cmd" = seed ]; then
      edit '.noise = ((.noise // []) + ($seed[0] | map(. + {added: $at, by: "seed"})) | unique_by(.pattern))' \
        --slurpfile seed "$HERE/data/seed-noise.json" --arg at "$(now)"
      echo "seeded $(jq length "$HERE/data/seed-noise.json") known-noise patterns" >&2
    fi
    ;;
  show)
    [ -s "$file" ] || { echo "no baseline for $env; run: baseline.sh capture --env $env"; exit 1; }
    jq -r '"baseline \(.env) captured \(.captured_at) over \(.window): \(.rates | length) rates, \(.presence | length) known alerts",
      "noise patterns:", (.noise[] | "  \(.pattern)  # \(.note // "")"),
      "top rates per hour:", (.rates | to_entries | sort_by(-.value) | .[:20][] | "  \(.value * 10 | round / 10)\t\(.key[0:120])")' "$file"
    ;;
  accept)
    key="${rest[0]:-}"; [ -n "$key" ] || { echo "accept needs a finding KEY" >&2; exit 2; }
    last="$dir/last.json"; [ -s "$last" ] || { echo "no last run for $env; run prod-health.sh first" >&2; exit 2; }
    rate="$(jq -r --arg k "$key" '[.results[] | (.window_s) as $w | .series[] | select(.key == $k) | (.count * 3600 / ((.window_s // $w) | if . < 1 then 1 else . end))] | max // empty' "$last")"
    if [ -n "$rate" ]; then
      edit '.rates[$k] = ([(.rates[$k] // 0), $r] | max) | .history += [{at: $at, action: "accept", key: $k, rate: $r, note: $n}]' \
        --arg k "$key" --argjson r "$rate" --arg at "$(now)" --arg n "$note"
      echo "baseline rate for $key is now >= $(printf '%.1f' "$rate")/h"
    elif [[ "$key" != alert:* ]]; then
      echo "$key was not counted in the last run ($last); run prod-health.sh (without --only) and retry." >&2
      echo "Absolute findings (crashloops, critical alerts, stuck rollouts) are silenced only with: noise add" >&2
      exit 1
    else
      # A firing alert: record it as known so it stops being reported as new.
      edit '.presence = ((.presence // []) + [$k] | unique) | .history += [{at: $at, action: "accept", key: $k, note: $n}]' \
        --arg k "$key" --arg at "$(now)" --arg n "$note"
      echo "$key recorded as known (absolute findings such as crashloops still fire; use 'noise add' to silence them)"
    fi
    ;;
  noise)
    sub="${rest[0]:-list}"; pat="${rest[1]:-}"
    case "$sub" in
      add) [ -n "$pat" ] && [ -n "$note" ] || { echo "noise add PATTERN --note TEXT" >&2; exit 2; }
        edit '.noise = ((.noise // []) | map(select(.pattern != $p))) + [{pattern: $p, note: $n, added: $at, by: "human"}]' \
          --arg p "$pat" --arg n "$note" --arg at "$(now)"; echo "added noise pattern $pat" ;;
      rm) edit '.noise |= map(select(.pattern != $p))' --arg p "$pat"; echo "removed $pat" ;;
      list) jq -r '.noise[]? | "\(.pattern)\t\(.by // "")\t\(.note // "")"' "$file" 2>/dev/null ;;
      *) echo "noise add|rm|list" >&2; exit 2 ;;
    esac
    ;;
  help|"") sed -n '2,/^[^#]/{/^#/s/^# \{0,1\}//p}' "$0" ;;
  *) echo "unknown command $cmd" >&2; exit 2 ;;
esac
