#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_check-deps.sh"

# start-issue: Start working on a Linear issue
# Sets status to In Progress, assigns to you, and checks out the git branch
# Usage: start-issue.sh [OPTIONS] ISSUE_ID
#   --no-branch  Skip git branch checkout
#   --json       Output as JSON
#   --help       Show this help

NO_BRANCH=false
JSON_OUTPUT=false
ISSUE_ID=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-branch) NO_BRANCH=true; shift ;;
        --json) JSON_OUTPUT=true; shift ;;
        --help|-h)
            echo "Usage: start-issue.sh [OPTIONS] ISSUE_ID"
            echo ""
            echo "Start working on an issue: set In Progress, assign to you, checkout branch."
            echo ""
            echo "Options:"
            echo "  --no-branch  Skip git branch checkout"
            echo "  --json       Output as JSON"
            echo "  --help       Show this help"
            exit 0
            ;;
        -*) echo "Unknown option: $1" >&2; exit 1 ;;
        *)
            if [[ -n "$ISSUE_ID" ]]; then
                echo "Error: exactly one issue identifier is required." >&2
                exit 2
            fi
            ISSUE_ID="$1"; shift ;;
    esac
done

ISSUE_ID=$(printf '%s' "$ISSUE_ID" | tr '[:lower:]' '[:upper:]')
if [[ ! "$ISSUE_ID" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]]; then
    echo "Error: exactly one Linear issue identifier is required (e.g., LIN-123)." >&2
    exit 2
fi
if ! command -v jq &>/dev/null; then
    echo "Error: jq is required to verify the updated issue." >&2
    exit 1
fi

COMMON_FLAGS=(--no-pager --quiet)
if [ "$JSON_OUTPUT" = true ]; then
    COMMON_FLAGS+=(--output json --compact)
fi

# `issues start` in 0.3.15 chooses the first type=started state, which can be
# Changes Required. Resolve the exact name within this issue's team instead.
JSON_FLAGS=(--output json --compact --no-pager --quiet --no-cache --retry 3)
VIEWER=$(linear-cli api query 'query { viewer { id } }' "${JSON_FLAGS[@]}")
VIEWER_ID=$(jq -er '.data.viewer.id | select(type == "string" and length > 0)' <<< "$VIEWER") || {
    echo "Error: could not resolve the authenticated user; issue was not updated." >&2
    exit 1
}
echo "Starting issue $ISSUE_ID..." >&2
linear-cli issues update "$ISSUE_ID" --state "In Progress" --assignee me "${JSON_FLAGS[@]}" >/dev/null
ISSUE=$(linear-cli issues get "$ISSUE_ID" "${JSON_FLAGS[@]}")
if ! jq -e --arg identifier "$ISSUE_ID" --arg viewer "$VIEWER_ID" \
    '.identifier == $identifier and .state.name == "In Progress" and .assignee.id == $viewer' \
    <<< "$ISSUE" >/dev/null; then
    echo "Error: fresh readback did not confirm $ISSUE_ID is In Progress and assigned to you; stopping before branch checkout. The update may have applied; inspect the issue before retrying." >&2
    exit 1
fi
if [ "$JSON_OUTPUT" = true ]; then
    printf '%s\n' "$ISSUE"
else
    echo "$ISSUE_ID: In Progress, assigned to you."
fi

# Checkout the git branch (if in a git repo and not skipped)
if [ "$NO_BRANCH" = false ]; then
    if git rev-parse --is-inside-work-tree &>/dev/null; then
        echo "Checking out branch for $ISSUE_ID..." >&2
        linear-cli git checkout "$ISSUE_ID" "${COMMON_FLAGS[@]}" || {
            echo "Warning: Could not checkout branch. You may need to create it manually." >&2
        }
    else
        echo "Not in a git repository, skipping branch checkout." >&2
    fi
fi

echo "Ready to work on $ISSUE_ID" >&2
