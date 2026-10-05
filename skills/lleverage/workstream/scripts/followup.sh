#!/usr/bin/env bash
# Create a workstream follow-up the agreed way, after checking for duplicates.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: followup.sh [OPTIONS] "Title"

Default placement: To Do, assigned to me, the team's current cycle.

Options:
  --parent ID       Parent issue. The follow-up inherits its project unless --project is given.
  --later           Very low urgency AND low priority: put it in the next cycle instead.
  --triage          A separate bug unrelated to the workstream: Triage, unassigned, no cycle.
  -p, --priority N  1 urgent, 2 high, 3 normal (default), 4 low.
  -d, --description TEXT   Markdown body. Say why it exists and what done looks like.
  -l, --label NAME  Label (repeatable).
  --project NAME    Project name (overrides the parent's).
  --team KEY        Team key (default LLE).
  --force           Create even when the duplicate check finds a close match.
  --dry-run         Show what would happen and stop.

Exit codes: 0 created, 3 possible duplicate (nothing created), 2 usage or API error.
If WS_DIR is set, each created issue is appended to $WS_DIR/issues.log.
EOF
}

die() { echo "followup: $*" >&2; exit 2; }
for c in linear-cli jq; do command -v "$c" >/dev/null || die "$c not on PATH"; done

team="LLE"; parent=""; later=false; triage=false; priority=3; desc=""; project=""; force=false; dry=false
labels=(); title=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --parent) parent="$(echo "$2" | tr '[:lower:]' '[:upper:]')"; shift 2 ;;
    --later) later=true; shift ;;
    --triage) triage=true; shift ;;
    -p|--priority) priority="$2"; shift 2 ;;
    -d|--description) desc="$2"; shift 2 ;;
    -l|--label) labels+=("$2"); shift 2 ;;
    --project) project="$2"; shift 2 ;;
    --team) team="$2"; shift 2 ;;
    --force) force=true; shift ;;
    --dry-run) dry=true; shift ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$title" ] || die "one title only"; title="$1"; shift ;;
  esac
done
[ -n "$title" ] || { usage >&2; exit 2; }
$later && $triage && die "--later and --triage are exclusive"
[[ "$priority" =~ ^[1-4]$ ]] || die "priority must be 1-4"

lq() { linear-cli api query "$@" --output json --compact --quiet; }
lm() { linear-cli api mutate "$@" --output json --compact --quiet; }
data() { jq -c '.data // .'; }

# Duplicate check: open issues whose titles share most significant words.
words() { echo "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' ' ' | tr ' ' '\n' \
  | awk 'length($0) > 3' | grep -vxE 'with|that|from|when|into|than|this|them|they|their|should|instead|after|before' | sort -u; }
mine="$(words "$title")"
n_mine="$(echo "$mine" | grep -c . || true)"
dups=""
if [ "$n_mine" -gt 0 ]; then
  while IFS=$'\t' read -r id state t; do
    [ -n "$id" ] || continue
    overlap="$(comm -12 <(echo "$mine") <(words "$t") | grep -c . || true)"
    if [ $(( overlap * 100 / n_mine )) -ge 50 ]; then dups+="  $id [$state] $t"$'\n'; fi
  done < <(lq 'query($t:String!,$k:String!){ searchIssues(term:$t, first:15, filter:{team:{key:{eq:$k}}, state:{type:{nin:["completed","canceled","duplicate"]}}}){ nodes{ identifier title state{name} } } }' \
      -v t="$title" -v k="$team" | data | jq -r '.searchIssues.nodes[] | [.identifier, .state.name, .title] | @tsv')
fi
if [ -n "$dups" ] && ! $force; then
  echo "Possible duplicates (nothing created). Reuse or comment on one of these, or rerun with --force:" >&2
  printf '%s' "$dups" >&2
  exit 3
fi

ctx="$(lq "query(\$key:String!){ viewer{id}
  teams(filter:{key:{eq:\$key}}){nodes{id states{nodes{id name}}}}
  cycles(filter:{team:{key:{eq:\$key}}, endsAt:{gt:\"$(date -u +%FT%TZ)\"}}, first:5){nodes{id number startsAt endsAt isActive}} }" -v key="$team" | data)"
team_id="$(echo "$ctx" | jq -r '.teams.nodes[0].id // empty')"; [ -n "$team_id" ] || die "team $team not found"
state_name="To Do"; $triage && state_name="Triage"
state_id="$(echo "$ctx" | jq -r --arg s "$state_name" '.teams.nodes[0].states.nodes[] | select(.name == $s) | .id')"
[ -n "$state_id" ] || die "state $state_name not found"
cycle_id=""; cycle_no=""
if ! $triage; then
  pick='[.cycles.nodes[]] | sort_by(.startsAt) | (map(select(.isActive)) | .[0]) as $cur
    | if $later then (map(select(.startsAt >= $cur.endsAt)) | .[0]) else $cur end | "\(.id) \(.number)"'
  read -r cycle_id cycle_no < <(echo "$ctx" | jq -r --argjson later "$later" "$pick")
  [ -n "$cycle_id" ] && [ "$cycle_id" != null ] || die "could not resolve the target cycle"
fi

input="$(jq -n --arg team "$team_id" --arg title "$title" --arg desc "$desc" --arg state "$state_id" \
  --argjson p "$priority" '{teamId:$team, title:$title, stateId:$state, priority:$p}
  + (if $desc != "" then {description:$desc} else {} end)')"
$triage || input="$(echo "$input" | jq --arg a "$(echo "$ctx" | jq -r .viewer.id)" --arg c "$cycle_id" '. + {assigneeId:$a, cycleId:$c}')"
if [ -n "$parent" ]; then
  pinfo="$(lq 'query($id:String!){ issue(id:$id){ id project{id} } }' -v id="$parent" | data)"
  pid="$(echo "$pinfo" | jq -r '.issue.id // empty')"; [ -n "$pid" ] || die "parent $parent not found"
  input="$(echo "$input" | jq --arg p "$pid" '. + {parentId:$p}')"
  [ -n "$project" ] || input="$(echo "$input" | jq --arg pr "$(echo "$pinfo" | jq -r '.issue.project.id // empty')" 'if $pr != "" then . + {projectId:$pr} else . end')"
fi
if [ -n "$project" ]; then
  prid="$(lq 'query($n:String!){ projects(filter:{name:{eq:$n}}){nodes{id}} }' -v n="$project" | data | jq -r '.projects.nodes[0].id // empty')"
  [ -n "$prid" ] || die "project $project not found"
  input="$(echo "$input" | jq --arg pr "$prid" '. + {projectId:$pr}')"
fi
if [ "${#labels[@]}" -gt 0 ]; then
  ids="$(for l in "${labels[@]}"; do
    lid="$(lq 'query($n:String!){ issueLabels(filter:{name:{eq:$n}}, first:5){nodes{id team{id}}} }' -v n="$l" | data \
      | jq -r --arg t "$team_id" '[.issueLabels.nodes[] | select(.team == null or .team.id == $t)][0].id // empty')"
    [ -n "$lid" ] || die "label $l not found"; echo "$lid"
  done | jq -R . | jq -sc .)"
  input="$(echo "$input" | jq --argjson l "$ids" '. + {labelIds:$l}')"
fi

if $dry; then
  echo "Would create in $state_name${cycle_no:+, cycle $cycle_no}:"; echo "$input" | jq .
  [ -z "$dups" ] || { echo "Despite possible duplicates:"; printf '%s' "$dups"; }
  exit 0
fi

out="$(lm 'mutation($input: IssueCreateInput!){ issueCreate(input:$input){ success issue{ identifier url cycle{number} state{name} } } }' \
  -v input="$input" | data)"
[ "$(echo "$out" | jq -r '.issueCreate.success')" = true ] || die "create failed: $out"
id="$(echo "$out" | jq -r '.issueCreate.issue.identifier')"
echo "$out" | jq -r '.issueCreate.issue | "\(.identifier) \(.state.name) cycle=\(.cycle.number // "none") \(.url)"'
if [ -n "${WS_DIR:-}" ]; then
  mkdir -p "$WS_DIR"
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$id" "${parent:--}" \
    "$($triage && echo triage || ($later && echo next-cycle || echo current-cycle))" "$title" >> "$WS_DIR/issues.log"
fi
