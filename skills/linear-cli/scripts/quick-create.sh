#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_check-deps.sh"

# quick-create: Create a Linear issue with common defaults
# Usage: quick-create.sh [OPTIONS] [TEAM] "Title"
# Defaults: To Do, assigned to me, current cycle, normal priority.
#   -p, --priority N    Priority (1=urgent, 2=high, 3=normal, 4=low) [default: 3]
#   -s, --state STATE   Workflow state (default: To Do)
#   -a, --assignee WHO  Assignee (default: me)
#   --no-assignee       Leave the issue unassigned
#   --no-cycle          Do not add the issue to the current cycle
#   --triage            Create in Triage, unassigned and without a cycle
#   -l, --label LABEL   Label to add (can repeat)
#   -d, --description   Description (markdown)
#   --due DATE          Due date (today, tomorrow, +3d, +1w, YYYY-MM-DD)
#   -e, --estimate N    Estimate in points
#   --project NAME      Add to a project
#   --json              Output as JSON
#   --dry-run           Preview without creating
#   --help              Show this help

DEFAULT_TEAM="LLE"

JSON_OUTPUT=false
DRY_RUN=false
TEAM=""
TITLE=""
PRIORITY="3"
STATE="To Do"
ASSIGNEE="me"
ADD_TO_CURRENT_CYCLE=true
LABELS=()
POSITIONAL=()
DESCRIPTION=""
DUE=""
ESTIMATE=""
PROJECT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -p|--priority) PRIORITY="$2"; shift 2 ;;
        -s|--state) STATE="$2"; shift 2 ;;
        -a|--assignee) ASSIGNEE="$2"; shift 2 ;;
        --no-assignee) ASSIGNEE=""; shift ;;
        --no-cycle) ADD_TO_CURRENT_CYCLE=false; shift ;;
        --triage) STATE="Triage"; ASSIGNEE=""; ADD_TO_CURRENT_CYCLE=false; shift ;;
        -l|--label) LABELS+=("$2"); shift 2 ;;
        -d|--description) DESCRIPTION="$2"; shift 2 ;;
        --due) DUE="$2"; shift 2 ;;
        -e|--estimate) ESTIMATE="$2"; shift 2 ;;
        --project) PROJECT="$2"; shift 2 ;;
        --json) JSON_OUTPUT=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        --help|-h)
            echo "Usage: quick-create.sh [OPTIONS] TEAM \"Title\""
            echo ""
            echo "Create an issue with common defaults (To Do, assigned to me, current cycle, normal priority)."
            echo ""
            echo "Options:"
            echo "  -p, --priority N    Priority 1-4 (default: 3=normal)"
            echo "  -s, --state STATE   Workflow state (default: To Do)"
            echo "  -a, --assignee WHO  Assignee (default: me)"
            echo "  --no-assignee       Leave unassigned"
            echo "  --no-cycle          Do not add to the current cycle"
            echo "  --triage            Create in Triage, unassigned and without a cycle"
            echo "  -l, --label LABEL   Label (repeatable)"
            echo "  -d, --description   Description (markdown)"
            echo "  --due DATE          Due date"
            echo "  -e, --estimate N    Estimate in points"
            echo "  --project NAME      Add to project"
            echo "  --json              Output as JSON"
            echo "  --dry-run           Preview without creating"
            echo "  --help              Show this help"
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2; exit 1 ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done

# Parse positional args: [TEAM] "Title"
# If one arg: it's the title, use default team
# If two args: first is team, second is title
if [ ${#POSITIONAL[@]} -eq 0 ]; then
    echo "Error: Title is required." >&2
    echo "Usage: quick-create.sh [TEAM] \"Title\"" >&2
    exit 1
elif [ ${#POSITIONAL[@]} -eq 1 ]; then
    TEAM="$DEFAULT_TEAM"
    TITLE="${POSITIONAL[0]}"
elif [ ${#POSITIONAL[@]} -eq 2 ]; then
    TEAM="${POSITIONAL[0]}"
    TITLE="${POSITIONAL[1]}"
else
    echo "Error: Too many positional arguments." >&2
    echo "Usage: quick-create.sh [TEAM] \"Title\"" >&2
    exit 1
fi

COMMON_FLAGS=(--no-pager --quiet)

CMD=(linear-cli issues create "$TITLE" -t "$TEAM" -p "$PRIORITY" -s "$STATE")
if [ -n "$ASSIGNEE" ]; then
    CMD+=(-a "$ASSIGNEE")
fi

for label in "${LABELS[@]}"; do
    CMD+=(-l "$label")
done

if [ -n "$DESCRIPTION" ]; then
    CMD+=(-d "$DESCRIPTION")
fi

if [ -n "$DUE" ]; then
    CMD+=(--due "$DUE")
fi

if [ -n "$ESTIMATE" ]; then
    CMD+=(-e "$ESTIMATE")
fi

if [ "$DRY_RUN" = true ]; then
    CMD+=(--dry-run)
    if [ "$JSON_OUTPUT" = true ]; then
        CMD+=(--output json --compact)
    fi
    CMD+=("${COMMON_FLAGS[@]}")
    "${CMD[@]}"
    exit 0
fi

if ! command -v jq &>/dev/null; then
    echo "ERROR: quick-create requires jq to add the issue to the current cycle." >&2
    exit 1
fi

CREATE_RESULT="$("${CMD[@]}" --output json --compact "${COMMON_FLAGS[@]}")"
ISSUE_ID="$(jq -r '.identifier // .issue.identifier // empty' <<<"$CREATE_RESULT")"

if [ -z "$ISSUE_ID" ]; then
    echo "ERROR: Issue was created, but its identifier could not be read from the CLI response." >&2
    echo "$CREATE_RESULT" >&2
    exit 1
fi

if [ "$ADD_TO_CURRENT_CYCLE" = true ]; then
    NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    CYCLES="$(linear-cli cycles list -t "$TEAM" --output json --compact "${COMMON_FLAGS[@]}")"
    CYCLE_ID="$(jq -r --arg now "$NOW" '[.cycles[] | select(.startsAt <= $now and .endsAt >= $now)][0].id // empty' <<<"$CYCLES")"

    if [ -z "$CYCLE_ID" ]; then
        echo "ERROR: $ISSUE_ID was created, but no current cycle was found for team $TEAM." >&2
        exit 1
    fi

    linear-cli api mutate \
        'mutation($id: String!, $cycleId: String!) {
           issueUpdate(id: $id, input: { cycleId: $cycleId }) {
             success issue { identifier }
           }
         }' \
        -v id="$ISSUE_ID" -v cycleId="$CYCLE_ID" \
        --output json --compact "${COMMON_FLAGS[@]}" >/dev/null
fi

if [ "$JSON_OUTPUT" = true ]; then
    linear-cli issues get "$ISSUE_ID" --output json --compact "${COMMON_FLAGS[@]}"
else
    linear-cli issues get "$ISSUE_ID" "${COMMON_FLAGS[@]}"
fi
