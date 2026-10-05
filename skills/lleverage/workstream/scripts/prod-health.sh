#!/usr/bin/env bash
# Compatibility shim: the health check now lives in the prod-health skill
# (skills/lleverage/prod-health/scripts/prod-health.sh). Use that directly.
# Usage: prod-health.sh [--env production|staging] [--window 30m] [--extra FILE] [WINDOW]
# Flags pass through unchanged; a bare WINDOW argument becomes --window WINDOW.
# The new script exits 3 (findings) or 4 (incomplete); this shim maps both to 0, as the
# old script printed a report and exited 0. Every other status passes through.
set -uo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
target=""
for c in "$here/../../prod-health/scripts/prod-health.sh" \
         "$HOME/.agents/skills/prod-health/scripts/prod-health.sh" \
         "$HOME/.claude/skills/prod-health/scripts/prod-health.sh"; do
  [ -x "$c" ] && { target="$c"; break; }
done
[ -n "$target" ] || { echo "prod-health: the prod-health skill is not installed (run agent-toolkit scripts/sync.sh)" >&2; exit 2; }

args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) exec "$target" --help ;;
    --*) args+=("$1"); case "$1" in --json|--raw|--results|--no-baseline) ;; *) [ "$#" -gt 1 ] && { args+=("$2"); shift; } ;; esac; shift ;;
    *) args+=(--window "$1"); shift ;;
  esac
done
"$target" "${args[@]+"${args[@]}"}"
rc=$?
case "$rc" in 3|4) exit 0 ;; esac
exit "$rc"
