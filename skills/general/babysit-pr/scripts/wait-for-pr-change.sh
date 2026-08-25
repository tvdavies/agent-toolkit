#!/usr/bin/env bash
# Capture canonical PR state or wait efficiently until that state changes.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  wait-for-pr-change.sh snapshot PR [--repo OWNER/REPO]
  wait-for-pr-change.sh wait PR --baseline FILE [--repo OWNER/REPO] [--interval SECONDS] [--timeout SECONDS]

Commands:
  snapshot  Print canonical relevant PR-state JSON.
  wait      Compare immediately with FILE, then poll internally until changed or timed out.

Defaults: --interval 60, --timeout 3600. Both changed and timeout events exit 0.
EOF
}

die() {
  echo "wait-for-pr-change: $*" >&2
  exit 2
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

for command in gh jq; do
  command -v "$command" >/dev/null 2>&1 || die "'$command' is not installed or not on PATH"
done

if command -v sha256sum >/dev/null 2>&1; then
  hash_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "sha256sum or shasum is required"
fi

[ "$#" -ge 2 ] || { usage >&2; exit 2; }
mode="$1"
pr="${2#\#}"
shift 2
[[ "$pr" =~ ^[1-9][0-9]*$ ]] || die "PR must be a positive integer, with an optional leading #"

repo=""
baseline=""
interval=60
timeout=3600
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$#" -ge 2 ] || die "--repo requires OWNER/REPO"
      repo="$2"
      shift 2
      ;;
    --repo=*)
      repo="${1#--repo=}"
      shift
      ;;
    --baseline)
      [ "$#" -ge 2 ] || die "--baseline requires a file"
      baseline="$2"
      shift 2
      ;;
    --baseline=*)
      baseline="${1#--baseline=}"
      shift
      ;;
    --interval)
      [ "$#" -ge 2 ] || die "--interval requires seconds"
      interval="$2"
      shift 2
      ;;
    --interval=*)
      interval="${1#--interval=}"
      shift
      ;;
    --timeout)
      [ "$#" -ge 2 ] || die "--timeout requires seconds"
      timeout="$2"
      shift 2
      ;;
    --timeout=*)
      timeout="${1#--timeout=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$mode" in
  snapshot|wait) ;;
  *) die "first argument must be snapshot or wait" ;;
esac
[[ "$interval" =~ ^[1-9][0-9]*$ ]] || die "--interval must be a positive integer"
[[ "$timeout" =~ ^[1-9][0-9]*$ ]] || die "--timeout must be a positive integer"
if [ -n "$repo" ]; then
  [[ "$repo" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] || die "--repo must be OWNER/REPO"
else
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) || die "could not derive repository; pass --repo OWNER/REPO"
fi
owner="${repo%%/*}"
name="${repo#*/}"

collect_threads() {
  local all='[]'
  local cursor=""
  local response nodes has_next
  while :; do
    local args=(api graphql -F owner="$owner" -F name="$name" -F pr="$pr")
    if [ -n "$cursor" ]; then args+=(-F cursor="$cursor"); fi
    response=$(gh "${args[@]}" -f query='
      query($owner:String!, $name:String!, $pr:Int!, $cursor:String) {
        repository(owner:$owner, name:$name) {
          pullRequest(number:$pr) {
            reviewThreads(first:100, after:$cursor) {
              nodes {
                id isResolved isOutdated path line originalLine
                comments(first:100) {
                  nodes { databaseId author { login __typename } body url createdAt updatedAt }
                  pageInfo { hasNextPage endCursor }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }') || return 1
    nodes=$(jq -c '.data.repository.pullRequest.reviewThreads.nodes // []' <<<"$response") || return 1
    all=$(jq -cn --argjson old "$all" --argjson new "$nodes" '$old + $new') || return 1
    has_next=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage // false' <<<"$response") || return 1
    [ "$has_next" = "true" ] || break
    cursor=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // empty' <<<"$response") || return 1
    [ -n "$cursor" ] || return 1
  done

  # A review thread can itself contain more than 100 replies. Complete those pages.
  local thread_id comment_cursor comments comment_response comment_nodes comments_more
  while IFS=$'\t' read -r thread_id comment_cursor; do
    [ -n "$thread_id" ] || continue
    comments=$(jq -c --arg id "$thread_id" '.[] | select(.id == $id) | .comments.nodes' <<<"$all") || return 1
    while [ -n "$comment_cursor" ]; do
      comment_response=$(gh api graphql -F id="$thread_id" -F cursor="$comment_cursor" -f query='
        query($id:ID!, $cursor:String) {
          node(id:$id) {
            ... on PullRequestReviewThread {
              comments(first:100, after:$cursor) {
                nodes { databaseId author { login __typename } body url createdAt updatedAt }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }') || return 1
      comment_nodes=$(jq -c '.data.node.comments.nodes // []' <<<"$comment_response") || return 1
      comments=$(jq -cn --argjson old "$comments" --argjson new "$comment_nodes" '$old + $new') || return 1
      comments_more=$(jq -r '.data.node.comments.pageInfo.hasNextPage // false' <<<"$comment_response") || return 1
      if [ "$comments_more" = "true" ]; then
        comment_cursor=$(jq -r '.data.node.comments.pageInfo.endCursor // empty' <<<"$comment_response") || return 1
        [ -n "$comment_cursor" ] || return 1
      else
        comment_cursor=""
      fi
    done
    all=$(jq -c --arg id "$thread_id" --argjson comments "$comments" '
      map(if .id == $id then .comments.nodes = $comments | .comments.pageInfo = {hasNextPage:false,endCursor:null} else . end)
    ' <<<"$all") || return 1
  done < <(jq -r '.[] | select(.comments.pageInfo.hasNextPage == true) | [.id, .comments.pageInfo.endCursor] | @tsv' <<<"$all")

  printf '%s\n' "$all"
}

collect_top_level_comments() {
  local pages
  pages=$(gh api --paginate "/repos/$owner/$name/issues/$pr/comments?per_page=100") || return 1
  jq -sc '
    (add // [])
    | map({
        databaseId: .id,
        id: .node_id,
        author: (if .user == null then null else {login:(.user.login // null), type:(.user.type // null)} end),
        body,
        createdAt: .created_at,
        updatedAt: .updated_at,
        url: .html_url
      })
  ' <<<"$pages"
}

collect_submitted_reviews() {
  local pages
  pages=$(gh api --paginate "/repos/$owner/$name/pulls/$pr/reviews?per_page=100") || return 1
  jq -sc '
    (add // [])
    | map(select(.submitted_at != null) | {
        databaseId: .id,
        id: .node_id,
        author: (if .user == null then null else {login:(.user.login // null), type:(.user.type // null)} end),
        state,
        body,
        submittedAt: .submitted_at,
        commitId: .commit_id,
        url: .html_url
      })
  ' <<<"$pages"
}

collect_snapshot() {
  local pr_json threads comments reviews
  pr_json=$(gh pr view "$pr" --repo "$repo" --json \
    number,url,state,isDraft,mergedAt,closedAt,updatedAt,headRefOid,headRefName,headRepository,headRepositoryOwner,isCrossRepository,baseRefName,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,statusCheckRollup) || return 1
  comments=$(collect_top_level_comments) || return 1
  reviews=$(collect_submitted_reviews) || return 1
  threads=$(collect_threads) || return 1

  jq -Scn --arg repo "$repo" --argjson pr "$pr_json" --argjson comments "$comments" --argjson reviews "$reviews" --argjson threads "$threads" '
    def actor: if . == null then null else {login:(.login // null)} end;
    def canonical_checks:
      map(del(.startedAt, .completedAt) + {startedAt:(.startedAt // null), completedAt:(.completedAt // null)})
      | sort_by((.name // .context // ""), (.workflowName // ""), (.detailsUrl // ""), (.startedAt // ""));
    def canonical_reviews:
      sort_by((.author.login // ""), (.submittedAt // ""), (.state // ""), (.body // ""));
    def canonical_comments:
      sort_by((.databaseId // 0), (.createdAt // ""), (.updatedAt // ""), (.url // ""));
    {
      repository: $repo,
      pr: ($pr | {
        number, url, state, isDraft, mergedAt, closedAt, updatedAt,
        headRefOid, headRefName,
        headRepository: (.headRepository // null),
        headRepositoryOwner: (.headRepositoryOwner | actor),
        isCrossRepository, baseRefName, mergeable, mergeStateStatus, reviewDecision,
        autoMergeRequest: (
          if .autoMergeRequest == null then null else {
            enabledAt: (.autoMergeRequest.enabledAt // null),
            enabledBy: (.autoMergeRequest.enabledBy | actor),
            mergeMethod: (.autoMergeRequest.mergeMethod // null)
          } end
        ),
        statusCheckRollup: ((.statusCheckRollup // []) | canonical_checks),
        reviews: ($reviews | canonical_reviews),
        comments: ($comments | canonical_comments)
      }),
      reviewThreads: ($threads
        | map({
            id, isResolved, isOutdated, path,
            line: (.line // .originalLine),
            comments: ((.comments.nodes // []) | canonical_comments)
          })
        | sort_by(.id))
    }
  '
}

if [ "$mode" = "snapshot" ]; then
  collect_snapshot || die "could not fetch PR #$pr state from $repo"
  exit 0
fi

[ -n "$baseline" ] || die "wait requires --baseline FILE"
[ -f "$baseline" ] || die "baseline does not exist: $baseline"
jq -e 'type == "object" and has("repository") and has("pr") and has("reviewThreads")' "$baseline" >/dev/null \
  || die "baseline is not a valid watcher snapshot: $baseline"
jq -e --arg repo "$repo" --argjson pr "$pr" '.repository == $repo and .pr.number == $pr' "$baseline" >/dev/null \
  || die "baseline belongs to a different repository or PR: $baseline"

baseline_dir=$(dirname "$baseline")
mkdir -p "$baseline_dir"
canonical_baseline=$(mktemp "$baseline_dir/.babysit-pr-baseline.XXXXXX")
current_file=$(mktemp "${TMPDIR:-/tmp}/babysit-pr-current.XXXXXX")
cleanup() { rm -f "$canonical_baseline" "$current_file"; }
interrupted() {
  cleanup
  jq -cn --arg event interrupted --arg repo "$repo" --argjson pr "$pr" '{event:$event,repository:$repo,pr:$pr}'
  exit 130
}
trap cleanup EXIT
trap interrupted INT TERM
jq -Sc . "$baseline" > "$canonical_baseline" || die "could not canonicalize baseline: $baseline"
mv "$canonical_baseline" "$baseline"
old_hash=$(hash_file "$baseline")
start=$(date +%s)
failures=0
max_failures=3

while :; do
  if collect_snapshot > "$current_file"; then
    failures=0
    new_hash=$(hash_file "$current_file")
    if [ "$new_hash" != "$old_hash" ]; then
      snapshot=$(cat "$current_file")
      temporary=$(mktemp "$baseline_dir/.babysit-pr-update.XXXXXX")
      cp "$current_file" "$temporary"
      mv "$temporary" "$baseline"
      jq -cn \
        --arg event changed \
        --arg repository "$repo" \
        --argjson pr "$pr" \
        --arg oldHash "$old_hash" \
        --arg newHash "$new_hash" \
        --argjson snapshot "$snapshot" \
        '{event:$event,repository:$repository,pr:$pr,oldHash:$oldHash,newHash:$newHash,snapshot:$snapshot}'
      exit 0
    fi
  else
    failures=$((failures + 1))
    if [ "$failures" -eq 1 ]; then
      echo "wait-for-pr-change: transient GitHub read failure; retrying" >&2
    fi
    if [ "$failures" -ge "$max_failures" ]; then
      die "GitHub state fetch failed $failures consecutive times for $repo#$pr"
    fi
  fi

  now=$(date +%s)
  elapsed=$((now - start))
  if [ "$elapsed" -ge "$timeout" ]; then
    jq -cn \
      --arg event timeout \
      --arg repository "$repo" \
      --argjson pr "$pr" \
      --arg hash "$old_hash" \
      --argjson elapsed "$elapsed" \
      '{event:$event,repository:$repository,pr:$pr,hash:$hash,elapsedSeconds:$elapsed}'
    exit 0
  fi

  remaining=$((timeout - elapsed))
  delay="$interval"
  if [ "$delay" -gt "$remaining" ]; then delay="$remaining"; fi
  sleep "$delay"
done
