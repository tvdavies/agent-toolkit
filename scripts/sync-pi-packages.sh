#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${AGENT_TOOLS_DIR:-$HOME/agent-skills}"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
NO_UPDATE=false
if [ "${1:-}" = "--no-update" ]; then
  NO_UPDATE=true
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "pi is not installed or not on PATH" >&2
  exit 1
fi

MANIFEST="$REPO_DIR/manifests/pi-packages.json"
if [ ! -f "$MANIFEST" ]; then
  echo "Missing Pi package manifest: $MANIFEST" >&2
  exit 1
fi

list_packages() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.packages[]' "$MANIFEST"
  else
    node -e "const m=require(process.argv[1]); for (const p of m.packages) console.log(p)" "$MANIFEST"
  fi
}

list_packages | while IFS= read -r pkg; do
  [ -n "$pkg" ] && pi install "$pkg"
done

if [ "$NO_UPDATE" = false ]; then
  pi update --extensions
fi
