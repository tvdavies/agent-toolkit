#!/usr/bin/env bash
# Deploys and change correlation: what rolled out recently, which lleverage commits
# and PRs each rollout carried, Argo CD syncs (app and infra repos), and failed
# Cloud Build deploy builds on recent main commits.
# Usage: deploys.sh [--env production|staging] [--window 30m] [--end ISO] [--json] [--raw]
#        [--lookback 3h]   how far back to look for deploys (default: max(window, 3h))
# Rollouts come from ReplicaSets still in the cluster (image change vs the previous
# revision; same-image restarts from Reloader are counted, not listed). Commits and
# PRs come from the GitHub REST compare API (gh api), never GraphQL.
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"
[[ " $* " == *" -h "* || " $* " == *" --help "* ]] && { ph_usage "$0"; exit 0; }
ph_parse_common "$@"
LOOKBACK=""
set -- "${PH_ARGS[@]+"${PH_ARGS[@]}"}"
while [ "$#" -gt 0 ]; do case "$1" in --lookback) LOOKBACK="$2"; shift 2 ;; *) shift ;; esac; done
LB_S="$(ph_duration_s "${LOOKBACK:-3h}")" || ph_die "bad --lookback"
[ "$LB_S" -lt "$PH_WIN_S" ] && LB_S="$PH_WIN_S"
LB_START_ISO="$(date -u -d "@$(( PH_END_S - LB_S ))" +%FT%TZ)"
ph_result_init deploys
GH_OK=1; command -v gh >/dev/null || GH_OK=0
ghapi() { [ "$GH_OK" = 1 ] && timeout 25 gh api "$@" 2>/dev/null; }
deploys='[]'

# --- rollouts from ReplicaSets -------------------------------------------------------
if ph_have_kube; then
  rs="$(ph_kubectl get rs -A -o json 2>/dev/null)" || { ph_unavailable "kubectl get rs failed"; rs='{"items":[]}'; }
  # For each ReplicaSet created in the lookback, find the previous revision's image.
  changes="$(echo "$rs" | jq -c --arg s "$LB_START_ISO" --arg e "$PH_END_ISO" '
    [.items[] | {ns: .metadata.namespace, owner: (.metadata.ownerReferences[0].name // ""), kind: (.metadata.ownerReferences[0].kind // ""),
       rev: (.metadata.annotations["deployment.kubernetes.io/revision"] // .metadata.annotations["rollout.argoproj.io/revision"] // "0" | tonumber),
       at: .metadata.creationTimestamp, image: .spec.template.spec.containers[0].image}]
    | group_by([.ns, .owner])[] | sort_by(.rev) | . as $h
    | range(1; length) as $i | $h[$i] as $cur | $h[$i - 1] as $prev
    | select($cur.at > $s and $cur.at <= $e)
    | {ns: $cur.ns, owner: $cur.owner, at: $cur.at, from: $prev.image, to: $cur.image}')"
  restarts="$(echo "$changes" | jq -s '[.[] | select(.from == .to)] | length')"
  # Group by (from tag, to tag): one release usually rolls many workloads.
  pairs="$(echo "$changes" | jq -sc '[.[] | select(.from != .to)]
    | map(. + {repo: (.to | sub(":[^:/]+$"; "") | split("/") | last | if . == "lleverage" then "app" else . end),
               old: (.from | capture(":(?<t>[^:/]+)$").t // ""), new: (.to | capture(":(?<t>[^:/]+)$").t // "")})
    | group_by([.old, .new]) | map({repos: ([.[].repo] | unique), old: .[0].old, new: .[0].new,
        namespaces: ([.[].ns] | unique), first: ([.[].at] | min), last: ([.[].at] | max)})
    | sort_by(.last) | reverse')"
  declare -A CMP=()
  while read -r p; do
    [ -n "$p" ] || continue
    old="$(jq -r .old <<<"$p")"; new="$(jq -r .new <<<"$p")"
    prs='[]'; ncommits=null
    if [[ "$old" =~ ^[0-9a-f]{40}$ && "$new" =~ ^[0-9a-f]{40}$ ]]; then
      k="$old...$new"
      if [ -z "${CMP[$k]:-}" ]; then
        CMP[$k]="$(ghapi "repos/$PH_GH_REPO/compare/$k" --jq '{n: .total_commits, prs: [.commits[] | .commit.message | split("\n")[0]
            | {title: (.[0:90]), pr: (capture("\\(#(?<n>[0-9]+)\\)$").n // null)}]}' || echo '{"n":null,"prs":[]}')"
      fi
      ncommits="$(jq -c .n <<<"${CMP[$k]}")"; prs="$(jq -c '.prs' <<<"${CMP[$k]}")"
    fi
    nns="$(jq -r '.namespaces | length' <<<"$p")"
    entry="$(jq -c --argjson prs "$prs" --argjson n "$ncommits" '{kind: "rollout", workload: (.repos | join(",")), workloads: .repos, namespaces, at: .last, first_at: .first,
        from: .old[0:10], to: .new[0:10], commits: $n, prs: $prs}' <<<"$p")"
    summary="$(jq -r --arg nns "$nns" '"\(.from)→\(.to) \(.first_at[11:16])-\(.at[11:16])Z: " + (if (.workloads | length) > 4 then (.workloads[:4] | join(",")) + ",+\(.workloads | length - 4)" else (.workloads | join(",")) end) + (if ($nns | tonumber) > (.workloads | length) then " (\($nns) ns)" else "" end)
        + (if .commits then ", \(.commits) commit(s): " + ([.prs[] | (if .pr then "#\(.pr) " else "" end) + .title[0:60]] | .[:4] | join("; ")) else "" end)' <<<"$entry")"
    deploys="$(jq -c --argjson e "$entry" --arg s "$summary" '. + [$e + {summary: $s}]' <<<"$deploys")"
  done < <(jq -c '.[]' <<<"$pairs")
  ph_data config_restarts "${restarts:-0}"

  # --- Argo CD syncs --------------------------------------------------------------------
  apps="$(ph_kubectl -n argocd get applications.argoproj.io -o json 2>/dev/null)" || { ph_unavailable "Argo CD applications unreadable"; apps='{"items":[]}'; }
  synced="$(echo "$apps" | jq -c --arg s "$LB_START_ISO" --arg e "$PH_END_ISO" '[.items[]
      | select((.status.operationState.finishedAt // "") > $s and (.status.operationState.finishedAt // "") <= $e)
      | {app: .metadata.name, repo: ((.spec.source.repoURL // .spec.sources[0].repoURL // "") | sub("^https://github.com/"; "") | sub("\\.git$"; "")),
         rev: (.status.operationState.syncResult.revision // .status.sync.revision // ""), phase: .status.operationState.phase,
         at: .status.operationState.finishedAt, msg: ((.status.operationState.message // "")[0:160])}]')"
  while read -r g; do
    [ -n "$g" ] || continue
    repo="$(jq -r .repo <<<"$g")"; rev="$(jq -r .rev <<<"$g")"; title=""
    if [[ "$repo" == lleverage-ai/* && "$rev" =~ ^[0-9a-f]{40}$ ]]; then
      title="$(ghapi "repos/$repo/commits/$rev" --jq '.commit.message | split("\n")[0][0:90]')"
    fi
    entry="$(jq -c --arg t "$title" '{kind: "argo", workload: (.apps | join(",")), namespaces: [], at, repo, rev: .rev[0:10], title: $t, phase}' <<<"$g")"
    deploys="$(jq -c --argjson e "$entry" '. + [$e + {summary: ("argo " + (if $e.rev != "" then "\($e.repo | split("/") | last)@\($e.rev) \($e.title[0:60]) → " else "" end) + "\($e.workload[0:80]) at \($e.at[11:16])Z \($e.phase)")}]' <<<"$deploys")"
  done < <(echo "$synced" | jq -c 'group_by([.repo, .rev])[] | {repo: .[0].repo, rev: .[0].rev, apps: [.[].app], at: ([.[].at] | max),
      phase: ([.[].phase] | unique | join(","))}')
  echo "$synced" | jq -c '.[] | select(.phase != "Succeeded" and .phase != "Running")' | while read -r f; do
    ph_finding sev2 "deploy.argo-failed:$(jq -r .app <<<"$f")" "$(jq -r '"Argo sync \(.phase) for \(.app) at \(.at): \(.msg)"' <<<"$f")" "$f"
  done
  if [ "$PH_LIVE" = 1 ]; then
    bad="$(echo "$apps" | jq -c --argjson now "$(date -u +%s)" '[.items[] | select(.status.health.status == "Degraded" or .status.health.status == "Missing")
        | select(($now - ((.status.health.lastTransitionTime // "1970-01-01T00:00:00Z") | fromdateiso8601)) > 600)
        | {app: .metadata.name, health: .status.health.status, sync: .status.sync.status}]')"
    while read -r b; do
      [ -n "$b" ] || continue
      ph_finding sev3 "deploy.argo-degraded:$(jq -r .app <<<"$b")" "$(jq -r '"Argo app \(.app) is \(.health) (\(.sync))"' <<<"$b")" "$b"
    done < <(jq -c '.[]' <<<"$bad")
    ph_data argo_out_of_sync "$(echo "$apps" | jq -c '[.items[] | select(.status.sync.status != "Synced") | .metadata.name]')"
  fi
else
  ph_unavailable "kubectl cannot reach the $PH_ENV cluster; rollouts and Argo skipped"
fi

# --- Cloud Build deploy builds on recent main commits ----------------------------------
# Production deploys build from main; staging from the app repo's staging branch.
BR=main; [ "$PH_ENV" = staging ] && BR=staging
if [ "$GH_OK" = 1 ]; then
  commits="$(ghapi "repos/$PH_GH_REPO/commits?sha=$BR&since=$LB_START_ISO&until=$PH_END_ISO&per_page=15" \
    --jq '[.[] | {sha, at: .commit.committer.date, title: (.commit.message | split("\n")[0][0:80])}]')" \
    || { ph_unavailable "GitHub commits API failed (rate limit?)"; commits='[]'; }
  builds='[]'
  while read -r c; do
    [ -n "$c" ] || continue
    sha="$(jq -r .sha <<<"$c")"
    runs="$(ghapi "repos/$PH_GH_REPO/commits/$sha/check-runs?per_page=100" \
      --jq '[.check_runs[] | select(.app.slug == "google-cloud-build") | {name: (.name | sub(" \\(lleverage\\)$"; "")), status, conclusion}]')" || continue
    builds="$(jq -c --argjson c "$c" --argjson r "$runs" '. + [$c + {runs: $r}]' <<<"$builds")"
  done < <(jq -c '.[]' <<<"$commits")
  # Newest first. A build failing on the newest two commits blocks fixes: SEV1 hint.
  echo "$builds" | jq -c '[.[] | .sha as $s | .at as $at | .title as $t | .runs[]
      | select(.conclusion == "failure" or .conclusion == "timed_out")
      | {name, sha: $s[0:10], at: $at, title: $t, conclusion}] | group_by(.name)[]
      | {name: .[0].name, n: length, latest: (sort_by(.at) | last)}' | while read -r f; do
    name="$(jq -r .name <<<"$f")"
    newest2="$(jq -r --arg n "$name" '[.[:2][] | [.runs[] | select(.name == $n) | .conclusion][0] // "none"] | join(",")' <<<"$builds")"
    if [ "$name" = main-tests ]; then hint=sev3; what="main CI red"
    else hint=sev2; what="deploy build failed"; [ "$newest2" = "failure,failure" ] && hint=sev1; fi
    ph_finding "$hint" "deploy.build:$name" "$what: $name on $(jq -r '"\(.n) commit(s), latest \(.latest.sha) \(.latest.title[0:60]) (\(.latest.conclusion))"' <<<"$f")" \
      "$(jq -c --arg nw "$newest2" '{latest_commit: .latest.sha, failing_commits: .n, newest_two: $nw}' <<<"$f")"
  done
  ph_data builds "$(jq -c '[.[] | {sha: .sha[0:10], at, title, failed: [.runs[] | select(.conclusion == "failure" or .conclusion == "timed_out") | .name],
      pending: [.runs[] | select(.status != "completed") | .name]}]' <<<"$builds")"
else
  ph_unavailable "gh not installed; commit, PR and build correlation skipped"
fi

ph_data deploys "$deploys"
ph_data lookback "$(jq -nc --arg s "$LB_START_ISO" '$s')"
ph_data summary "$(jq -nc --argjson d "$deploys" --argjson r "${restarts:-0}" --arg lb "$(( LB_S / 60 ))m" \
  '"last \($lb): \([$d[] | select(.kind == "rollout")] | length) image rollout(s), \([$d[] | select(.kind == "argo")] | length) Argo sync group(s), \($r) same-image restarts"')"
for d in $(jq -r 'range(0; length)' <<<"$deploys"); do ph_note "$(jq -r ".[$d].summary" <<<"$deploys")"; done
ph_emit
