#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_check-deps.sh"

# sprint-status: Show current sprint progress and remaining work
# Usage: sprint-status.sh [OPTIONS] TEAM
#   --json       Output as JSON
#   --burndown   Show burndown chart
#   --velocity   Show velocity across sprints
#   --help       Show this help

DEFAULT_TEAM="LLE"

JSON_OUTPUT=false
SHOW_BURNDOWN=false
SHOW_VELOCITY=false
TEAM=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --json) JSON_OUTPUT=true; shift ;;
        --burndown) SHOW_BURNDOWN=true; shift ;;
        --velocity) SHOW_VELOCITY=true; shift ;;
        --help|-h)
            echo "Usage: sprint-status.sh [OPTIONS] TEAM"
            echo ""
            echo "Show current sprint progress and remaining work."
            echo ""
            echo "Options:"
            echo "  --json       Output as JSON"
            echo "  --burndown   Show burndown chart"
            echo "  --velocity   Show velocity across sprints"
            echo "  --help       Show this help"
            exit 0
            ;;
        -*) echo "Unknown option: $1" >&2; exit 1 ;;
        *) TEAM="$1"; shift ;;
    esac
done

if [ -z "$TEAM" ]; then
    TEAM="$DEFAULT_TEAM"
fi

COMMON_FLAGS=(--no-pager --quiet)
if [ "$JSON_OUTPUT" = true ]; then
    COMMON_FLAGS+=(--output json --compact)
fi

# Show sprint progress
linear-cli sprint status -t "$TEAM" "${COMMON_FLAGS[@]}"

echo ""
linear-cli sprint progress -t "$TEAM" "${COMMON_FLAGS[@]}"

if [ "$SHOW_BURNDOWN" = true ]; then
    echo ""
    linear-cli sprint burndown -t "$TEAM" "${COMMON_FLAGS[@]}"
fi

if [ "$SHOW_VELOCITY" = true ]; then
    echo ""
    linear-cli sprint velocity -t "$TEAM" "${COMMON_FLAGS[@]}"
fi
