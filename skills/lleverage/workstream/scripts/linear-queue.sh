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
  has-pr       an open GitHub PR is linked to the issue in Linear (any repo), an open PR
               anywhere in the search owners names it in its title (or body, after
               Closes/Fixes/Resolves),
               or an open PR in the tracked repos names it in its title or branch.
  blocked      an open issue blocks it.
  parent       it has open children. Work the children, not the parent.
  umbrella-done  all of its children are closed. Check its acceptance and close it.
  eligible     none of the above. Readiness still needs a human-level check.

--json prints one JSON object per issue instead of TSV. It also carries the facts the
continuous sweep's gate filters on: assignee and assignedToMe, openAncestor (any
ancestor still open, whatever its state), stateType, size (XS..XL from the estimate,
else the description's "Size:" line, else null) and prepared (the description's
"**Status:**" verdict written by prepare-ticket, such as Ready, else null).
"**Status:** Ready from <date>" (14 Nov 2026, 14 November 2026 or 2026-11-14) sets
readyFrom to the ISO date and is prepared "Ready" only from that date (UTC);
before it, or when the date can't be read (readyFrom null), it is "Ready later".
Open PRs (prs) come from three places, so no repo list decides whether a ticket is
claimed:
  1. the GitHub PR attachments Linear holds on the issue, in any repo its GitHub
     integration links (only while Linear's synced status is draft, open, inReview or
     approved);
  2. a GitHub search of every open PR owned by $WS_SEARCH_OWNERS (space separated,
     default "lleverage-ai"), matching the identifier in the title, or in the body
     after a closing word (Closes, Fixes, Resolves, Completes). A bare mention in a
     body doesn't count. Search can't see branch names, and new PRs take a minute or
     so to be indexed;
  3. a title/branch scan of the tracked repos, the fallback for branch-only mentions:
     $WS_REPOS (space separated), default "lleverage-ai/lleverage
     lleverage-ai/infrastructure lleverage-ai/agent-sdk lleverage-ai/llegal
     lleverage-ai/istor lleverage-ai/delta-integrations".
A search or scan that fails prints a warning on stderr and is left out.
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
  assignee{name isMe} description
  parent{identifier state{name type} parent{identifier state{name type} parent{identifier state{name type}}}}
  inverseRelations(first:20){nodes{type issue{identifier state{type}}}}
  children(first:50){nodes{identifier state{type}}}
  attachments(first:20, filter:{sourceType:{eq:"github"}}){nodes{url metadata}}'

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

# Open PRs that name an identifier, to spot work already under way elsewhere. Linear's own
# PR links (the attachments above) are the first source. Each line is "owner/repo#n<TAB>text".
: > "$tmp/prs.tsv"
# Every open PR in the org, by GitHub search, in any repo. An identifier counts when it is in
# the title, or in the body after a closing word (Closes, Fixes, Resolves, Completes and their
# forms). A bare mention in a body ("out of scope, see LLE-1", "stacked as LLE-2") does not
# count: on 1 Nov 2026 every eligible ticket that only a body mentioned was a false claim.
for owner in ${WS_SEARCH_OWNERS:-lleverage-ai}; do
  if gh search prs --owner "$owner" --state open --limit 1000 --json repository,number,title,body > "$tmp/search.json"; then
    [ "$(jq length "$tmp/search.json")" -lt 1000 ] \
      || echo "linear-queue: warning: 1000 or more open PRs in $owner; some may be missed" >&2
    jq -r '.[] | "\(.repository.nameWithOwner)#\(.number)\t\(
             ([.title | match("\\b[A-Za-z]+-[0-9]+\\b"; "g").string]
              + [.body // "" | match("\\b(?:close[sd]?|closing|fix(?:e[sd])?|fixing|resolve[sd]?|resolving|complete[sd]?|completing)\\b:?\\s+\\[?(?:https://linear\\.app/[^/\\s]+/issue/)?([A-Za-z]+-[0-9]+)\\b"; "gi").captures[0].string])
             | map(ascii_upcase) | unique | join(" "))"' "$tmp/search.json" >> "$tmp/prs.tsv"
  else
    echo "linear-queue: warning: could not search open PRs owned by $owner" >&2
  fi
done
# Fallback: titles and branch names in the tracked repos (search doesn't cover branches).
for repo in ${WS_REPOS:-lleverage-ai/lleverage lleverage-ai/infrastructure lleverage-ai/agent-sdk lleverage-ai/llegal lleverage-ai/istor lleverage-ai/delta-integrations}; do
  gh pr list -R "$repo" --state open --limit 300 --json number,title,headRefName \
    | jq -r --arg r "$repo" '.[] | "\($r)#\(.number)\t\(.title) \(.headRefName)"' >> "$tmp/prs.tsv" \
    || echo "linear-queue: warning: could not list open PRs in $repo" >&2
done
# Index it once, identifier -> [PR refs], so each issue is a lookup rather than a scan.
jq -R -s '
  split("\n") | map(select(length > 0) | split("\t")
    | {ref: .[0], ids: [.[1:] | join(" ") | match("\\b[A-Za-z]+-[0-9]+\\b"; "g").string | ascii_upcase]})
  | reduce .[] as $p ({}; reduce ($p.ids | unique)[] as $id (.; .[$id] += [$p.ref]))' \
  "$tmp/prs.tsv" > "$tmp/prs.json"

jq -c --slurpfile prs "$tmp/prs.json" '
  def started: . == "started";
  def openish: (. == "completed" or . == "canceled" or . == "duplicate") | not;
  # "14 Nov 2026", "14 November 2026" or "2026-11-14" at the start of the string, as YYYY-MM-DD; empty if unreadable.
  def isodate:
    ascii_downcase
    | ((capture("^(?<y>[0-9]{4})-(?<m>[0-9]{2})-(?<d>[0-9]{2})\\b") | "\(.y)-\(.m)-\(.d)")
       // (capture("^(?<d>[0-9]{1,2})(st|nd|rd|th)?\\s+(?<mon>[a-z]{3,9})\\.?,?\\s+(?<y>[0-9]{4})\\b")
           | .mon as $mon
           | (["january","february","march","april","may","june","july","august","september","october","november","december"]
              | map(startswith($mon)) | index(true)) as $m
           | select($m != null)
           | "\(.y)-\($m + 101 | tostring | .[1:])-\(.d | tonumber + 100 | tostring | .[1:])"))
    | . as $s | select((try (strptime("%Y-%m-%d") | mktime | strftime("%Y-%m-%d")) catch null) == $s);
  (now | strftime("%Y-%m-%d")) as $today
  | . as $i
  | [$i.parent, $i.parent.parent?, $i.parent.parent.parent?] | map(select(. != null)) as $anc
  | ($prs[0][$i.identifier | ascii_upcase] // []) as $scanned
  # GitHub PRs Linear links to the issue, in any repo, while the synced status says they are
  # open (draft, open, inReview, approved). A link with no status, such as one pasted by hand,
  # does not count. (No apostrophes in this program: it is single-quoted.)
  | [($i.attachments.nodes // [])[]
     | select((.metadata.status // "" | IN("draft", "open", "inReview", "approved"))
              and .metadata.mergedAt == null and .metadata.closedAt == null)
     | .url | capture("^https://github\\.com/(?<repo>[^/]+/[^/]+)/pull/(?<n>[0-9]+)")?
     | "\(.repo)#\(.n)"] as $linked
  | ($linked + $scanned | unique) as $pr
  | [$i.inverseRelations.nodes[] | select(.type == "blocks" and (.issue.state.type | openish)) | .issue.identifier] as $blk
  | [$i.children.nodes[] | select(.state.type | openish)] as $kids
  | ($i.description // "") as $desc
  # Linear t-shirt estimates are stored on the Fibonacci scale.
  | ({"1": "XS", "2": "S", "3": "M", "5": "L", "8": "XL"}[($i.estimate // 0 | tostring)]
     // ($desc | [match("(?m)^\\s*\\**Size:?\\**:?\\s*\\**\\s*(XS|S|M|L|XL)\\b"; "g") | .captures[0].string] | last)) as $size
  | ($desc | [match("(?m)^\\s*\\*\\*Status:\\*\\*\\s*(Ready|Needs decision|Blocked|Not needed|Human Required)(?:\\s+from:?\\s+([^\\n]*))?"; "gi") | [.captures[].string]] | first) as $status
  # "Ready from <date>" is Ready only once the date has come; an unreadable date is never Ready.
  | (if $status != null and ($status[0] | ascii_downcase) == "ready" and $status[1] != null
     then ([$status[1] | isodate] | first) else null end) as $readyFrom
  | (if $status == null then null
     elif ($status[0] | ascii_downcase) == "ready" and $status[1] != null
       then (if $readyFrom != null and $readyFrom <= $today then "Ready" else "Ready later" end)
     else $status[0] end) as $prepared
  | {
      id: $i.identifier, title: $i.title, url: $i.url, priority: $i.priority, estimate: $i.estimate,
      state: $i.state.name, stateType: $i.state.type,
      cycle: ($i.cycle.number // null), project: ($i.project.name // null),
      labels: [$i.labels.nodes[].name],
      assignee: ($i.assignee.name // null), assignedToMe: ($i.assignee.isMe // false),
      openAncestor: ($anc | any(.state.type | openish)),
      size: $size, prepared: $prepared, readyFrom: $readyFrom,
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
