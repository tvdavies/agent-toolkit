#!/usr/bin/env bash
# Kubernetes health: pods not ready, crashloops and restarts in the window,
# deployments and Argo Rollouts mid-rollout or stuck, and the image tag per workload.
# Usage: k8s.sh [--env production|staging] [--window 30m] [--end ISO] [--json] [--raw]
# Live state comes from kubectl (only when the window ends now); crashloops and
# restarts inside the window come from kube-state-metrics in VictoriaMetrics, so
# --end in the past still works for those.
set -uo pipefail
. "$(dirname "$0")/../lib/common.sh"
[[ " $* " == *" -h "* || " $* " == *" --help "* ]] && { ph_usage "$0"; exit 0; }
ph_parse_common "$@"
ph_result_init k8s

CORE_NS='^(app|workflow-service|session-service|agent-service|credential-service|actions-gateway|integration-action-service|integration-service|data-service|knowledge-service|channels-service|nats|redis)$'
ph_have_kube || ph_bail "kubectl cannot reach the $PH_ENV cluster (KUBECONFIG=$KUBECONFIG)"

# Pod name -> workload name (strip ReplicaSet hash and pod suffix).
WL='def wl: sub("-[a-z0-9]{8,10}-[a-z0-9]{5}$"; "") | sub("-[a-z0-9]{5}$"; "") | sub("-[0-9a-f]{8}$"; "-*");'

# --- history from kube-state-metrics -------------------------------------------
if ph_ensure_vm; then
  W="${PH_WIN_S}s"
  reasons="$(ph_vm_query "max by (namespace, pod, container, reason) (max_over_time(kube_pod_container_status_waiting_reason{reason=~\"CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError\"}[$W])) > 0" 2>/dev/null)"
  [ -n "$reasons" ] || ph_unavailable "kube-state-metrics crashloop query failed"
  restarts="$(ph_vm_query "sum by (namespace, pod, container) (increase(kube_pod_container_status_restarts_total[$W])) >= 1" 2>/dev/null)"
  [ -n "$restarts" ] || ph_unavailable "kube-state-metrics restart query failed"
  if [ -n "$reasons" ]; then
    # ErrImagePull and ImagePullBackOff are one problem; CrashLoopBackOff wins over the rest.
    echo "$reasons" | jq -c "$WL"' .[]? | {ns: .metric.namespace, pod: .metric.pod, c: .metric.container, wl: (.metric.pod | wl),
        reason: (.metric.reason | if test("ImagePull") then "ImagePull" else . end)}' \
      | jq -sc 'group_by([.ns, .wl])[] | {ns: .[0].ns, wl: .[0].wl, pods: ([.[].pod] | unique), containers: ([.[].c] | unique),
          reason: ([.[].reason] | unique | if index("CrashLoopBackOff") then "CrashLoopBackOff" else .[0] end)}' \
      | while read -r g; do
          ns="$(jq -r .ns <<<"$g")"; wl="$(jq -r .wl <<<"$g")"; reason="$(jq -r .reason <<<"$g")"
          hint=sev2; [[ "$ns" =~ $CORE_NS ]] && hint=sev1
          ph_finding "$hint" "k8s.waiting:$ns/$wl:$reason" "$reason in $ns/$wl ($(jq -r '.pods | length' <<<"$g") pod(s), container $(jq -r '.containers | join(",")' <<<"$g"))" \
            "$(jq -c '{pods: .pods[:5]}' <<<"$g")" "$ns"
        done
  fi
  if [ -n "$restarts" ]; then
    # Org namespaces share one key (org-*), so their counts are summed first.
    echo "$restarts" | jq -c "$WL"' .[]? | {ns: .metric.namespace, cls: (.metric.namespace | if startswith("org-") then "org-*" else . end),
        wl: (.metric.pod | wl), c: .metric.container, n: (.value[1] | tonumber | round)}' \
      | jq -sc 'group_by([.cls, .wl, .c])[] | {cls: .[0].cls, wl: .[0].wl, c: .[0].c, n: (map(.n) | add),
          nss: (group_by(.ns) | map({key: .[0].ns, value: (map(.n) | add)}) | from_entries)}' \
      | while read -r g; do
          ns1="$(jq -r '.nss | to_entries | sort_by(-.value) | .[0].key' <<<"$g")"
          ph_series "k8s.restarts:$(jq -r '.cls + "/" + .wl + ":" + .c' <<<"$g")" "$(jq -r .n <<<"$g")" \
            "container restarts $(jq -r 'if (.nss | length) > 1 then "\(.cls) (\(.nss | length) ns)" else (.nss | keys[0]) end' <<<"$g")/$(jq -r '.wl + " (" + .c + ")"' <<<"$g")" \
            "$(jq -c --arg ns "$ns1" '{rules:["new","spike"], min_new:2, min_spike:3, hint:"sev3", namespace:$ns, evidence:{namespaces:.nss}}' <<<"$g")"
        done
    nrestart="$(echo "$restarts" | jq '[.[]? | .value[1] | tonumber] | add // 0 | round')"
  fi
else
  ph_unavailable "VictoriaMetrics port-forward failed; crashloop and restart history skipped"
fi

# --- live state from kubectl ---------------------------------------------------
summary_live=""
if [ "$PH_LIVE" = 1 ]; then
  now="$(date -u +%s)"
  pods="$(ph_kubectl get pods -A -o json 2>/dev/null)" || { ph_unavailable "kubectl get pods failed"; pods='{"items":[]}'; }
  # Failed pods (evicted, node shutdown) no longer serve and their controller has
  # replaced them, so they are counted, not reported.
  nfailed="$(echo "$pods" | jq '[.items[] | select(.status.phase == "Failed")] | length')"
  [ "$nfailed" -gt 0 ] && ph_note "$nfailed failed pod(s) left over (evicted or node shutdown); not counted as unhealthy"
  # Not ready for more than 5 minutes (ignores completed job pods and fresh pods).
  echo "$pods" | jq -c --argjson now "$now" "$WL"'
    .items[] | select(.status.phase != "Succeeded" and .status.phase != "Failed")
    | select(($now - (.metadata.creationTimestamp | fromdateiso8601)) > 300)
    | select(.metadata.ownerReferences[0].kind? != "Job")
    | . as $p
    | ([.status.conditions[]? | select(.type == "Ready")][0]) as $r
    | select($p.status.phase != "Running" or ($r.status != "True" and ($now - ($r.lastTransitionTime // $p.metadata.creationTimestamp | fromdateiso8601)) > 300))
    | {ns: .metadata.namespace, wl: (.metadata.name | wl), pod: .metadata.name, phase: .status.phase,
       why: ([.status.containerStatuses[]? | .state.waiting.reason // empty] + [.status.conditions[]? | select(.status != "True") | .reason // empty] | unique | join(","))}' \
    | jq -sc 'group_by([.ns, .wl])[] | {ns: .[0].ns, wl: .[0].wl, n: length, phase: ([.[].phase] | unique | join(",")), why: ([.[].why] | unique | join(";")), pods: [.[].pod][:3]}' \
    | while read -r g; do
        ns="$(jq -r .ns <<<"$g")"; wl="$(jq -r .wl <<<"$g")"
        cls="$ns"; [[ "$ns" == org-* ]] && cls='org-*'
        hint=sev3; [[ "$ns" =~ $CORE_NS ]] && hint=sev2
        ph_finding "$hint" "k8s.notready:$cls/$wl" "$(jq -r '"\(.n) pod(s) not ready >5m in \(.ns)/\(.wl): \(.phase) \(.why)"' <<<"$g")" "$(jq -c '{pods}' <<<"$g")" "$ns"
      done

  deps="$(ph_kubectl get deploy -A -o json 2>/dev/null)" || { ph_unavailable "kubectl get deployments failed"; deps='{"items":[]}'; }
  ros="$(ph_kubectl get rollouts.argoproj.io -A -o json 2>/dev/null)" || { ph_unavailable "kubectl get rollouts failed"; ros='{"items":[]}'; }
  # Deployments mid-rollout or stuck. Workload-ref'd deployments scaled to 0 are skipped.
  echo "$deps" | jq -c --argjson now "$now" '
    .items[] | select((.spec.replicas // 1) > 0)
    | ([.status.conditions[]? | select(.type == "Progressing")][0]) as $pc
    | select((.status.updatedReplicas // 0) < .spec.replicas or (.status.availableReplicas // 0) < .spec.replicas
             or (.status.observedGeneration // 0) < .metadata.generation or $pc.reason == "ProgressDeadlineExceeded")
    | {ns: .metadata.namespace, name: .metadata.name, want: .spec.replicas, updated: (.status.updatedReplicas // 0),
       avail: (.status.availableReplicas // 0), reason: ($pc.reason // ""),
       age_s: ($now - ($pc.lastUpdateTime // .metadata.creationTimestamp | fromdateiso8601))}' \
    | while read -r d; do
        ns="$(jq -r .ns <<<"$d")"; name="$(jq -r .name <<<"$d")"
        stuck="$(jq -r 'if .reason == "ProgressDeadlineExceeded" or .age_s > 900 then "stuck" else "rolling" end' <<<"$d")"
        hint=sev3; [ "$stuck" = stuck ] && { hint=sev2; [[ "$ns" =~ $CORE_NS ]] && hint=sev1; }
        cls="$ns"; [[ "$ns" == org-* ]] && cls='org-*'
        if [ "$stuck" = stuck ]; then
          ph_finding "$hint" "k8s.rollout-stuck:$cls/$name" "$(jq -r '"deployment \(.ns)/\(.name) stuck: \(.updated)/\(.want) updated, \(.avail) available, \(.reason) for \((.age_s/60)|floor)m"' <<<"$d")" "$d" "$ns"
        else
          ph_note "rolling: $(jq -r '"\(.ns)/\(.name) \(.updated)/\(.want) updated, \(.avail) available"' <<<"$d")"
        fi
      done
  echo "$ros" | jq -c '.items[] | select(.status.phase != "Healthy")
    | {ns: .metadata.namespace, name: .metadata.name, phase: .status.phase, msg: (.status.message // ""), abort: (.status.abort // false)}' \
    | while read -r r; do
        ns="$(jq -r .ns <<<"$r")"
        if jq -e '.phase == "Degraded" or .abort' <<<"$r" >/dev/null; then
          ph_finding sev2 "k8s.rollout-degraded:$ns/$(jq -r .name <<<"$r")" "$(jq -r '"Argo Rollout \(.ns)/\(.name) \(.phase): \(.msg)"' <<<"$r")" "$r" "$ns"
        else
          ph_note "rollout: $(jq -r '"\(.ns)/\(.name) \(.phase) \(.msg)"' <<<"$r")"
        fi
      done

  # Image tag per workload. Deployments that an Argo Rollout drives are scaled to 0
  # but their template is still the source of truth, so include them.
  images="$(echo "$deps" | jq -c '[.items[] | {ns: .metadata.namespace, name: .metadata.name,
      image: (.spec.template.spec.containers[0].image), replicas: (.spec.replicas // 0)}
    | . + {repo: (.image | sub(":[^:/]+$"; "") | split("/") | last), tag: (.image | capture(":(?<t>[^:/]+)$").t // "latest")}
    | select(.replicas > 0 or (.tag | test("^[0-9a-f]{40}$")))]')"
  ph_data images "$(echo "$images" | jq -c 'group_by(.repo + ":" + .tag) | map({repo: .[0].repo, tag: .[0].tag, count: length,
      namespaces: ([.[].ns] | map(if startswith("org-") then "org-*" else . end) | unique)}) | sort_by(-.count)')"
  ph_data workloads "$images"
  npods="$(echo "$pods" | jq '.items | length')"
  shas="$(echo "$images" | jq -r '[.[] | select(.tag | test("^[0-9a-f]{40}$")) | .tag[0:10]] | group_by(.) | map("\(.[0])x\(length)") | join(" ")')"
  summary_live="$npods pods; lleverage image tags: ${shas:-none}"
else
  ph_note "window ends in the past: live pod and rollout state skipped (history from kube-state-metrics only)"
fi

nf="$(wc -l <"$PH_FINDINGS")"
ph_data summary "$(jq -nc --arg s "${summary_live:+$summary_live; }restarts in window: ${nrestart:-?}; problems: $nf" '$s')"
ph_emit
