# Scaleway Redis Access

Use when asked to inspect or connect to Redis on the bare-metal Scaleway clusters.

## Safety rules

- Treat production Redis as live customer data.
- Default to **read-only inspection**. Do not run destructive or mutating Redis commands unless the user explicitly approves the exact command and target environment.
- Destructive/mutating commands include, but are not limited to: `DEL`, `UNLINK`, `FLUSH*`, `SET`, `HSET`, `ZREM`, `ZADD`, `EXPIRE`, `PERSIST`, `RENAME`, `EVAL`, `MIGRATE`, `RESTORE`, `CONFIG SET`, `SCRIPT LOAD`, `XDEL`, `XTRIM`.
- Safe inspection commands include: `PING`, `TYPE`, `TTL`, `SCAN`, `GET`, `MGET`, `HLEN`, `LLEN`, `SCARD`, `ZCARD`, `XLEN`, bounded `HSCAN`, bounded `LRANGE`, bounded `ZRANGE`/`ZREVRANGE`, bounded `XRANGE`, and occasional `INFO`.
- Never use `KEYS` on production Redis; it can block the Redis event loop. Use cursor-based `SCAN`/`--scan` with a narrow `--pattern` instead.
- Avoid unbounded collection reads on production Redis:
  - avoid `SMEMBERS` on large sets; use `SSCAN`
  - avoid `HGETALL` on large hashes; check `HLEN`, then use `HSCAN` or targeted `HGET`
  - avoid `LRANGE key 0 -1`; check `LLEN`, then use bounded ranges
  - avoid `ZRANGE`/`ZREVRANGE key 0 -1`; check `ZCARD`, then use bounded ranges or `ZSCAN`
  - avoid `XRANGE key - +` without `COUNT`; check `XLEN`, then use `XRANGE ... COUNT <n>`
- Avoid expensive operational/debug commands in production unless explicitly approved: `MONITOR`, `SORT`, broad `MEMORY USAGE` loops, heavy `EVAL` scripts, large set/zset unions/intersections (`SUNION`, `SINTER`, `SDIFF`, `ZUNIONSTORE`, `ZINTERSTORE`), `SAVE`, `BGSAVE`, `BGREWRITEAOF`, and `CONFIG SET`.
- Prefer bounded reads (`SCAN --pattern ... COUNT 100`, `ZRANGE key 0 20`, `LRANGE key 0 20`) and avoid broad unbounded dumps.
- Never copy Redis passwords into chat or shell history. Use in-cluster `REDIS_PASSWORD_FILE`/`REDISCLI_AUTH` as shown below.
- Do not expose Redis directly over the tailnet unless there is a separate approved security decision. Prefer `kubectl exec` or temporary `kubectl port-forward` to the current master.
- If starting `kubectl port-forward`, stop it when done and mention whether it is still running.

## Tailnet notes

- Headscale tailnet service is `tailscaled-llev`, not the default `tailscaled`.
- Use the custom socket for Tailscale CLI commands:

```bash
tailscale --socket=/run/tailscale-llev/tailscaled.sock status
```

- Existing tailnet bridges expose admin UIs. Redis is not exposed as a tailnet hostname.
- A Kubernetes API tailnet bridge may exist as `k8s-prod.ts.llev.dev` / `k8s-staging.ts.llev.dev`, but Redis access should still go through Kubernetes auth and the helper scripts.

## Cluster credentials

- Kubeconfigs are local sensitive artefacts and are expected at:
  - `../infrastructure/generated/staging/kubeconfig`
  - `../infrastructure/generated/production/kubeconfig`
- `generated/` contents are not version-controlled. If missing/stale, ask the user for the latest generated bundle or retrieval workflow.
- Do not commit `generated/`, `cluster.env`, kubeconfigs, talosconfigs, OpenBao init material, unseal keys, or service account keys.

## Helper scripts

From the monorepo root:

```bash
../infrastructure/scripts/redis-cli-master.sh production
../infrastructure/scripts/redis-cli-master.sh staging
```

This opens `redis-cli` inside the cluster against the current Sentinel master without copying the Redis password locally.

For local tools such as RedisInsight:

```bash
../infrastructure/scripts/redis-port-forward-master.sh production 6379
../infrastructure/scripts/redis-port-forward-master.sh staging 6379
```

Then connect local tooling to `127.0.0.1:6379`. Use `REDISCLI_AUTH` or the tool password field; do not embed the password in a Redis URL because it may contain shell-hostile characters.

## Read-only manual command

```bash
kubectl -n redis exec bare-metal-redis-helm-node-0 -c redis -- sh -lc '
  export REDISCLI_AUTH="$(cat "$REDIS_PASSWORD_FILE")"
  master="$(redis-cli --no-auth-warning -h bare-metal-redis-helm.redis.svc.cluster.local -p 26379 SENTINEL get-master-addr-by-name mymaster)"
  host="$(printf "%s\n" "$master" | sed -n "1p")"
  port="$(printf "%s\n" "$master" | sed -n "2p")"
  redis-cli --no-auth-warning -h "$host" -p "$port" PING
'
```

For interactive use, prefer read-only commands unless the user explicitly approves a mutation.

## Agent v2 thread lookup example

For an org/project thread index, first find the organisation ID if needed, then inspect the zset:

```bash
kubectl -n redis exec bare-metal-redis-helm-node-0 -c redis -- sh -lc '
  export REDISCLI_AUTH="$(cat "$REDIS_PASSWORD_FILE")"
  master="$(redis-cli --no-auth-warning -h bare-metal-redis-helm.redis.svc.cluster.local -p 26379 SENTINEL get-master-addr-by-name mymaster)"
  host="$(printf "%s\n" "$master" | sed -n "1p")"
  port="$(printf "%s\n" "$master" | sed -n "2p")"
  key="agent:v2:threads:org:<org-id>:project:<project-id>"
  redis-cli --no-auth-warning -h "$host" -p "$port" TYPE "$key"
  redis-cli --no-auth-warning -h "$host" -p "$port" TTL "$key"
  redis-cli --no-auth-warning -h "$host" -p "$port" ZREVRANGE "$key" 0 20 WITHSCORES
'
```
