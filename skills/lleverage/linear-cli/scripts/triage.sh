#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_check-deps.sh"

# triage: Show untriaged/unassigned issues for a team
# Usage: triage.sh [OPTIONS] TEAM
#   --json       Output as JSON
#   --since DAYS Only show issues created in last N days (default: 7)
#   --help       Show this help

DEFAULT_TEAM="LLE"

JSON_OUTPUT=false
SINCE_DAYS=7
TEAM=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --json) JSON_OUTPUT=true; shift ;;
        --since) SINCE_DAYS="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: triage.sh [OPTIONS] TEAM"
            echo ""
            echo "Show untriaged/unassigned issues for a team."
            echo ""
            echo "Options:"
            echo "  --json         Output as JSON"
            echo "  --since DAYS   Only issues created in last N days (default: 7)"
            echo "  --help         Show this help"
            exit 0
            ;;
        -*) echo "Unknown option: $1" >&2; exit 1 ;;
        *) TEAM="$1"; shift ;;
    esac
done

if [ -z "$TEAM" ]; then
    TEAM="$DEFAULT_TEAM"
fi

# Uses GraphQL to bypass broken CLI filters (state.type!=, assignee.name=)
python3 - "$TEAM" "$JSON_OUTPUT" "$SINCE_DAYS" << 'PYEOF'
import subprocess, json, sys
from datetime import datetime, timedelta, timezone

team = sys.argv[1]
json_output = sys.argv[2] == "true"
since_days = int(sys.argv[3])

since_date = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime("%Y-%m-%dT00:00:00.000Z")

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

# Triage state issues (no assignee, open, recent)
data = gql("""
{
  issues(
    filter: {
      team: { key: { eq: "%s" } }
      state: { type: { nin: ["completed", "canceled"] } }
      assignee: { null: true }
      createdAt: { gte: "%s" }
    }
    first: 50
    orderBy: createdAt
  ) {
    nodes {
      identifier
      title
      priority
      state { name }
      project { name }
      labels { nodes { name } }
      createdAt
      creator { name }
    }
  }
}
""" % (team, since_date))

unassigned = data.get("issues", {}).get("nodes", [])

# Also get triage-state issues (assigned but in Triage state)
triage_data = gql("""
{
  issues(
    filter: {
      team: { key: { eq: "%s" } }
      state: { name: { eq: "Triage" } }
      createdAt: { gte: "%s" }
    }
    first: 50
    orderBy: createdAt
  ) {
    nodes {
      identifier
      title
      priority
      state { name }
      project { name }
      labels { nodes { name } }
      assignee { name }
      createdAt
      creator { name }
    }
  }
}
""" % (team, since_date))

triage_items = triage_data.get("issues", {}).get("nodes", [])

if json_output:
    print(json.dumps({"unassigned": unassigned, "triage": triage_items}))
    sys.exit(0)

# Pretty print
print(f"Triage ({team}) — last {since_days} days")
print()

if triage_items:
    print(f"  In Triage ({len(triage_items)}):")
    for i in triage_items:
        priority = i.get("priority", 0)
        p_marker = {1: "!!!", 2: "!!", 3: "!", 4: "."}.get(priority, " ")
        assignee = i.get("assignee", {})
        assignee_str = f" -> {assignee['name']}" if assignee else ""
        creator = i.get("creator", {}).get("name", "")
        print(f"    {p_marker:>3} {i['identifier']}: {i['title']}{assignee_str} (by {creator})")
    print()

if unassigned:
    print(f"  Unassigned ({len(unassigned)}):")
    for i in unassigned:
        priority = i.get("priority", 0)
        p_marker = {1: "!!!", 2: "!!", 3: "!", 4: "."}.get(priority, " ")
        state = i.get("state", {}).get("name", "?")
        creator = i.get("creator", {}).get("name", "")
        print(f"    {p_marker:>3} {i['identifier']}: {i['title']} [{state}] (by {creator})")
    print()

if not triage_items and not unassigned:
    print("  Nothing to triage!")
PYEOF
