#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_check-deps.sh"

# my-issues: Show MY assigned issues via GraphQL (bypasses broken CLI flags)
# Usage: my-issues.sh [OPTIONS] [TEAM]
#   --all        Show all my open issues, not just current cycle
#   --json       Output as JSON (for agent consumption)
#   --team TEAM  Filter to a specific team (or pass as positional arg)
#   --help       Show this help

DEFAULT_TEAM="LLE"

SHOW_ALL=false
JSON_OUTPUT=false
TEAM=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --all) SHOW_ALL=true; shift ;;
        --json) JSON_OUTPUT=true; shift ;;
        --team) TEAM="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: my-issues.sh [OPTIONS] [TEAM]"
            echo ""
            echo "Show your assigned issues. Defaults to current cycle for $DEFAULT_TEAM."
            echo ""
            echo "Options:"
            echo "  --all        Show all my open issues, not just current cycle"
            echo "  --json       Output as JSON"
            echo "  --team TEAM  Filter to a specific team (default: $DEFAULT_TEAM)"
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

python3 - "$TEAM" "$JSON_OUTPUT" "$SHOW_ALL" << 'PYEOF'
import subprocess, json, sys

team = sys.argv[1]
json_output = sys.argv[2] == "true"
show_all = sys.argv[3] == "true"
CLOSED_STATES = {"Done", "Canceled", "Cancelled", "Duplicate"}

def gql(query):
    r = subprocess.run(
        ["linear-cli", "api", "query", query,
         "--output", "json", "--compact", "--no-pager", "--quiet"],
        capture_output=True, text=True, timeout=30
    )
    if r.returncode != 0:
        print(f"GraphQL error: {r.stderr or r.stdout}", file=sys.stderr)
        sys.exit(1)
    return json.loads(r.stdout).get("data", {})

if show_all:
    # All open issues across the team (no cycle filter)
    data = gql("""
    {
      viewer {
        name
        assignedIssues(
          filter: {
            team: { key: { eq: "%s" } }
            state: { type: { nin: ["completed", "canceled"] } }
          }
          first: 100
          orderBy: updatedAt
        ) {
          nodes {
            identifier
            title
            priority
            state { name }
            project { name }
            labels { nodes { name } }
          }
        }
      }
    }
    """ % team)
    issues = data.get("viewer", {}).get("assignedIssues", {}).get("nodes", [])
    heading = f"All open issues ({team})"
else:
    # Current cycle issues
    data = gql("""
    {
      viewer {
        name
        assignedIssues(
          filter: {
            cycle: { isActive: { eq: true } }
            team: { key: { eq: "%s" } }
          }
          first: 100
          orderBy: updatedAt
        ) {
          nodes {
            identifier
            title
            priority
            state { name }
            project { name }
            labels { nodes { name } }
          }
        }
      }
    }
    """ % team)
    issues = data.get("viewer", {}).get("assignedIssues", {}).get("nodes", [])

    # Also get cycle metadata
    cycle_data = gql("""
    {
      teams(filter: { key: { eq: "%s" } }) {
        nodes {
          activeCycle { number startsAt endsAt }
        }
      }
    }
    """ % team)
    cycle = (cycle_data.get("teams", {}).get("nodes", [{}])[0] or {}).get("activeCycle", {})
    cycle_num = cycle.get("number", "?")
    cycle_ends = (cycle.get("endsAt") or "")[:10]
    heading = f"Sprint {cycle_num} ({team}) — ends {cycle_ends}"

if json_output:
    print(json.dumps(issues))
    sys.exit(0)

if not issues:
    print(f"No issues assigned to you ({team}).")
    sys.exit(0)

# Group by state
by_state = {}
for i in issues:
    state = i.get("state", {}).get("name", "Unknown")
    by_state.setdefault(state, []).append(i)

state_order = ["In Progress", "Technical Review", "To Do", "Backlog", "Triage", "Done", "Canceled", "Duplicate"]
sorted_states = sorted(by_state.keys(), key=lambda s: state_order.index(s) if s in state_order else 99)

done_count = sum(len(v) for k, v in by_state.items() if k in CLOSED_STATES)
open_count = len(issues) - done_count

print(f"{heading} — {open_count} open, {done_count} done")
print()
for state in sorted_states:
    items = by_state[state]
    print(f"  {state} ({len(items)}):")
    for i in items:
        priority = i.get("priority", 0)
        p_marker = {1: "!!!", 2: "!!", 3: "!", 4: "."}.get(priority, " ")
        project = i.get("project")
        project_name = f" [{project['name']}]" if project else ""
        labels = [l["name"] for l in i.get("labels", {}).get("nodes", [])]
        label_str = f" ({', '.join(labels)})" if labels else ""
        print(f"    {p_marker:>3} {i['identifier']}: {i['title']}{project_name}{label_str}")
    print()
PYEOF
