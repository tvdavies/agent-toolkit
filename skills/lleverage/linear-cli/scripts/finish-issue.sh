#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_check-deps.sh"

# finish-issue: Mark the current branch's issue as Done
# Detects the issue from the git branch name, or accepts an explicit ID
# Usage: finish-issue.sh [OPTIONS] [ISSUE_ID]
#   --json       Output as JSON
#   --help       Show this help

JSON_OUTPUT=false
ISSUE_ID=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --json) JSON_OUTPUT=true; shift ;;
        --help|-h)
            echo "Usage: finish-issue.sh [OPTIONS] [ISSUE_ID]"
            echo ""
            echo "Mark an issue as Done. Detects from git branch if no ID given."
            echo ""
            echo "Options:"
            echo "  --json       Output as JSON"
            echo "  --help       Show this help"
            exit 0
            ;;
        -*) echo "Unknown option: $1" >&2; exit 1 ;;
        *) ISSUE_ID="$1"; shift ;;
    esac
done

COMMON_FLAGS=(--no-pager --quiet)
if [ "$JSON_OUTPUT" = true ]; then
    COMMON_FLAGS+=(--output json --compact)
fi

if [ -n "$ISSUE_ID" ]; then
    # Explicit issue ID provided
    echo "Marking $ISSUE_ID as Done..." >&2
    linear-cli issues close "$ISSUE_ID" "${COMMON_FLAGS[@]}"
else
    # Detect from git branch
    if ! git rev-parse --is-inside-work-tree &>/dev/null; then
        echo "Error: Not in a git repo and no issue ID provided." >&2
        exit 1
    fi

    echo "Detecting issue from branch..." >&2
    linear-cli done "${COMMON_FLAGS[@]}"
fi

echo "Issue marked as Done." >&2
