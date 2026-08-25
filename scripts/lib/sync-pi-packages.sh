#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
REPO_DIR="${AGENT_TOOLS_DIR:-$DEFAULT_REPO_DIR}"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
NO_UPDATE=false
if [ "${1:-}" = "--no-update" ]; then NO_UPDATE=true; shift; fi
[ "$#" -eq 0 ] || { echo "Usage: sync-pi-packages.sh [--no-update]" >&2; exit 2; }

command -v pi >/dev/null 2>&1 || { echo "pi is not installed or not on PATH" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is not installed or not on PATH" >&2; exit 1; }

MANIFEST="$REPO_DIR/manifests/pi-packages.json"
STATE_FILE="$HOME/.local/state/agent-toolkit/pi-packages.json"
[ -f "$MANIFEST" ] || { echo "Missing Pi package manifest: $MANIFEST" >&2; exit 1; }

mapfile -t desired < <(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); for (const p of m.packages) console.log(p)' "$MANIFEST")
if [ -f "$STATE_FILE" ]; then
  mapfile -t previous < <(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); for (const p of m.packages || []) console.log(p)' "$STATE_FILE")
else
  # One-time migration: this package was installed by the toolkit's previous
  # manifest, before managed package state existed.
  previous=("npm:@diegopetrucci/pi-openai-fast")
fi

for package in "${previous[@]}"; do
  [ -n "$package" ] || continue
  if ! printf '%s\n' "${desired[@]}" | grep -Fxq "$package"; then
    echo "Removing toolkit-managed Pi package $package"
    pi remove "$package" || echo "warning: could not remove $package (it may already be absent)" >&2
  fi
done

for package in "${desired[@]}"; do
  [ -n "$package" ] || continue
  pi install "$package"
done

mkdir -p "$(dirname "$STATE_FILE")"
node -e 'const fs=require("fs"); const source=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); fs.writeFileSync(process.argv[2], JSON.stringify({version:1, packages:source.packages}, null, 2)+"\n")' "$MANIFEST" "$STATE_FILE"

if [ "$NO_UPDATE" = false ]; then pi update --extensions; fi
