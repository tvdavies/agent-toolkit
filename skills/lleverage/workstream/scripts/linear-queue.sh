#!/usr/bin/env bash
# List Linear work for a workstream or sweep, with the facts eligibility depends on.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  linear-queue.sh cycle [--team LLE] [--all-assignees] [--json]
  linear-queue.sh tree ROOT-ID [--include-closed] [--json]

cycle  Open issues in the team's active cycle (assigned to me unless --all-assignees).
tree   ROOT-ID and every open descendant, breadth-first.

Each row reports: id, priority, state, verdict, blockers, open PR, ancestry, title.

Verdicts (sweep rules; tree mode reports them too):
  claimed      an ancestor is in a started state (In Progress, Technical Review, ...).
               Another workstream owns that tree. Never touch it from a sweep.
  started      the issue itself is in a started state. Someone is on it.
  has-pr       an open PR in the tracked repos mentions the identifier.
  blocked      an open issue blocks it.
  parent       it has open children. Work the children, not the parent.
  umbrella-done  all of its children are closed. Check its acceptance and close it.
  eligible     none of the above. Readiness still needs a human-level check.

--json prints one JSON object per issue instead of TSV.
Tracked repos for PR detection: $WS_REPOS (space separated), default
"lleverage-ai/lleverage lleverage-ai/infrastructure lleverage-ai/agent-sdk".
EOF
}

die() { echo "linear-queue: $*" >&2; exit 2; }
for c in linear-cli gh jq; do command -v "$c" >/dev/null || die "$c not on PATH"; done

[ "$#" -ge 1 ] || { usage >&2; exit 2; }
mode="$1"; shift
team="LLE"; root=""; json=false; mine=true; closed=false
case "$mode" in
  -h|--help) usage; exit 0 ;;
  cycle) ;;
  tree) [ "$#" -ge 1 ] || die "tree needs ROOT-ID"; root="$(echo "$1" | tr '[:lower:]' '[:upper:]')"; shift ;;
  *) die "unknown mode $mode" ;;
esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    --team) team="$2"; shift 2 ;;
    --all-assignees) mine=false; shift ;;
    --json) json=true; shift ;;
    --include-closed) closed=true; shift ;;
    *) die "unknown option $1" ;;
  esac
done

FIELDS='identifier title priority estimate url
  state{name type} labels{nodes{name}} project{name} cycle{number}
  parent{identifier state{name type} parent{identifier state{name type} parent{identifier state{name type}}}}
  inverseRelations(first:20){nodes{type issue{identifier state{type}}}}
  children(first:50){nodes{identifier state{type}}}'

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
: > "$tmp/issues.jsonl"

lq() { linear-cli api query "$@" --output json --compact --quiet; }
nodes() { jq -c '(.data.issues // .issues // .data.issue // .issue) | if type == "object" and has("nodes") then .nodes[] else . end'; }

if [ "$mode" = cycle ]; then
  assignee=''
  $mine && assignee='assignee:{isMe:{eq:true}},'
  q="query(\$after:String){ issues(first:50, after:\$after, filter:{team:{key:{eq:\"$team\"}}, cycle:{isActive:{eq:true}}, $assignee state:{type:{nin:[\"completed\",\"canceled\",\"duplicate\"]}}}){ pageInfo{hasNextPage endCursor} nodes{ $FIELDS } } }"
  after=""
  while :; do
    if [ -n "$after" ]; then out="$(lq "$q" -v after="$after")"; else out="$(lq "$q")"; fi
    echo "$out" | nodes >> "$tmp/issues.jsonl"
    [ "$(echo "$out" | jq -r '(.data.issues // .issues).pageInfo.hasNextPage')" = true ] || break
    after="$(echo "$out" | jq -r '(.data.issues // .issues).pageInfo.endCursor')"
  done
else
  frontier="$root"
  q="query(\$id:String!){ issue(id:\$id){ $FIELDS } }"
  while [ -n "$frontier" ]; do
    next=""
    for id in $frontier; do
      out="$(lq "$q" -v id="$id")" || die "could not read $id"
      issue="$(echo "$out" | jq -c '.data.issue // .issue')"
      [ "$issue" != null ] || die "$id not found"
      echo "$issue" >> "$tmp/issues.jsonl"
      next="$next $(echo "$issue" | jq -r '[.children.nodes[] | .identifier] | join(" ")')"
    done
    frontier="$(echo "$next" | xargs)"
  done
fi

# Open PRs in the tracked repos, to spot work already under way elsewhere.
: > "$tmp/prs.tsv"
for repo in ${WS_REPOS:-lleverage-ai/lleverage lleverage-ai/infrastructure lleverage-ai/agent-sdk}; do
  gh pr list -R "$repo" --state open --limit 300 --json number,title,headRefName \
    | jq -r --arg r "$repo" '.[] | "\($r)#\(.number)\t\(.title) \(.headRefName)"' >> "$tmp/prs.tsv" || true
done

jq -c --rawfile prs "$tmp/prs.tsv" '
  def started: . == "started";
  def openish: (. == "completed" or . == "canceled" or . == "duplicate") | not;
  . as $i
  | [$i.parent, $i.parent.parent?, $i.parent.parent.parent?] | map(select(. != null)) as $anc
  | ($prs | split("\n") | map(select(length > 0))
     | map(select(ascii_downcase | test("\\b" + ($i.identifier | ascii_downcase) + "\\b")))
     | map(split("\t")[0])) as $pr
  | [$i.inverseRelations.nodes[] | select(.type == "blocks" and (.issue.state.type | openish)) | .issue.identifier] as $blk
  | [$i.children.nodes[] | select(.state.type | openish)] as $kids
  | {
      id: $i.identifier, title: $i.title, priority: $i.priority, estimate: $i.estimate,
      state: $i.state.name, cycle: ($i.cycle.number // null), project: ($i.project.name // null),
      labels: [$i.labels.nodes[].name],
      ancestry: [$anc[] | "\(.identifier):\(.state.name)"],
      blockers: $blk, prs: $pr, openChildren: ($kids | length),
      verdict: (
        if ($anc | any(.state.type | started)) then "claimed"
        elif ($i.state.type | started) then "started"
        elif ($pr | length) > 0 then "has-pr"
        elif ($blk | length) > 0 then "blocked"
        elif ($kids | length) > 0 then "parent"
        elif ($i.children.nodes | length) > 0 then "umbrella-done"
        else "eligible" end),
      closed: ($i.state.type | openish | not)
    }' "$tmp/issues.jsonl" | jq -c --argjson closed "$closed" 'select($closed or (.closed | not))' > "$tmp/out.jsonl"

if $json; then
  cat "$tmp/out.jsonl"
else
  printf 'id\tP\tstate\tverdict\tblockers\tprs\tancestry\ttitle\n'
  # Linear priority 0 means "no priority", so it sorts after Low (4).
  jq -r '[.id, (if .priority == 0 then "P-" else "P\(.priority)" end), .state, .verdict,
          (.blockers | join(",")), (.prs | join(",")), (.ancestry | join(" < ")), .title[0:90]] | @tsv' \
    "$tmp/out.jsonl" | sort -t$'\t' -k4,4 -k2,2
fi
