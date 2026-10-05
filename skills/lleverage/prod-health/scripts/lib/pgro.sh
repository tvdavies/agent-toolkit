# shellcheck shell=bash
# Read-only Postgres access through a pod's cloud-sql-proxy sidecar.
# Source after common.sh. Usage:
#   ph_pg_query NAMESPACE POD_PREFIX SECRET_KEY "SQL"   -> prints psql -At output
#
# The database URL comes from secret NAMESPACE/service-secrets, is parsed into
# PG* environment variables for the psql child only, and is never printed or
# written to disk. Every session runs with default_transaction_read_only=on.

ph_pg_query() {
  local ns="$1" prefix="$2" key="$3" sql="$4" pod port env_lines
  command -v psql >/dev/null || { echo "psql not installed" >&2; return 1; }
  pod="$(ph_kubectl -n "$ns" get pods -o json 2>/dev/null | jq -r --arg p "$prefix" '
    [.items[] | select(.metadata.name | startswith($p)) | select(.status.phase == "Running")
     | select(any(.status.containerStatuses[]?, .status.initContainerStatuses[]?; .name == "cloud-sql-proxy" and .ready))] | .[0].metadata.name // empty')"
  [ -n "$pod" ] || { echo "no running $prefix pod with a ready cloud-sql-proxy in $ns" >&2; return 1; }
  port="$(ph_port_forward "$ns" "pod/$pod" 5432)" || { echo "port-forward to $ns/$pod failed" >&2; return 1; }
  # Parse the URL in a child; only KEY=VALUE lines for psql's environment come back.
  env_lines="$(ph_kubectl -n "$ns" get secret service-secrets -o json 2>/dev/null \
    | jq -r --arg k "$key" '.data[$k] // empty' | base64 -d 2>/dev/null \
    | PORT="$port" python3 -c '
import os, sys, urllib.parse as u
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(1)
p = u.urlsplit(raw)
vals = {"PGHOST": "127.0.0.1", "PGPORT": os.environ["PORT"], "PGUSER": u.unquote(p.username or ""),
        "PGPASSWORD": u.unquote(p.password or ""), "PGDATABASE": p.path.lstrip("/")}
for k, v in vals.items():
    print(f"{k}={v}")
')" || { echo "could not read $key from $ns/service-secrets" >&2; return 1; }
  (
    while IFS='=' read -r k v; do export "$k=$v"; done <<<"$env_lines"
    export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000' PGCONNECT_TIMEOUT=10 PGAPPNAME=prod-health
    timeout 45 psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c "$sql"
  )
}

# Organisation names, cached for a short TTL (default 6h) in the env state dir.
# Prints the cache path ({"<id>": {"name":..,"short":..}}) on success.
ph_org_names() {
  local cache="$PH_STATE_DIR/org-names.json" ttl="${PH_ORG_TTL_S:-21600}" rows
  mkdir -p "$PH_STATE_DIR"
  if [ -s "$cache" ] && [ $(( $(date +%s) - $(stat -c %Y "$cache") )) -lt "$ttl" ]; then echo "$cache"; return 0; fi
  rows="$(ph_pg_query app app-deployment DATABASE_URL \
    'SELECT id, name, "shortName" FROM organisations' 2>"$(ph_tmp)/orgnames.err")" || {
    [ -s "$cache" ] && { echo "$cache"; return 0; }   # stale beats nothing
    return 1
  }
  printf '%s\n' "$rows" | jq -R -s 'split("\n") | map(select(length > 0) | split("\t"))
    | map({key: .[0], value: {name: .[1], short: .[2]}}) | from_entries' >"$cache.tmp" && mv "$cache.tmp" "$cache"
  echo "$cache"
}
