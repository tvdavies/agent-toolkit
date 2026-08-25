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
        *) ISSUE_ID="$1"; shift ;;
    esac
done

if [ -z "$ISSUE_ID" ]; then
    echo "Error: Issue ID is required (e.g., LIN-123)" >&2
    exit 1
fi

COMMON_FLAGS=(--no-pager --quiet)
if [ "$JSON_OUTPUT" = true ]; then
    COMMON_FLAGS+=(--output json --compact)
fi

# Start the issue (sets In Progress + assigns to me)
echo "Starting issue $ISSUE_ID..." >&2
linear-cli issues start "$ISSUE_ID" "${COMMON_FLAGS[@]}"

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
