#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_DIR="${AGENT_TOOLS_DIR:-$DEFAULT_REPO_DIR}"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
cd "$REPO_DIR"

FORCE=false
if [ "${1:-}" = "--force" ]; then
  FORCE=true
  shift
fi

OLD_REF="${1:-}"
NEW_REF="${2:-HEAD}"

if [ -z "$OLD_REF" ] && git rev-parse --verify ORIG_HEAD >/dev/null 2>&1; then
  OLD_REF="ORIG_HEAD"
fi

old_ref_is_valid() {
  [ -n "$OLD_REF" ] && git rev-parse --verify "$OLD_REF" >/dev/null 2>&1
}

changed_any() {
  if [ "$FORCE" = true ]; then
    return 0
  fi

  if ! old_ref_is_valid; then
    return 1
  fi

  git diff --name-only "$OLD_REF" "$NEW_REF" -- "$@" | grep -q .
}

run_npm_install() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not installed or not on PATH; skipping dependency sync" >&2
    return 0
  fi

  if [ -f "$REPO_DIR/package-lock.json" ] && ! changed_any package.json; then
    npm ci --omit=dev --prefix "$REPO_DIR"
  else
    npm install --omit=dev --prefix "$REPO_DIR"
  fi
}

ensure_skill_link() {
  local target="$1"
  local link_path="$2"
  local parent
  parent="$(dirname "$link_path")"
  mkdir -p "$parent"

  if [ -e "$link_path" ] && [ ! -L "$link_path" ]; then
    echo "$link_path exists and is not a symlink; refusing to overwrite" >&2
    return 1
  fi

  ln -sfn "$target" "$link_path"
}

ensure_pi_package_installed() {
  if ! command -v pi >/dev/null 2>&1; then
    echo "pi is not installed or not on PATH; skipping Pi package sync" >&2
    return 0
  fi

  if pi list 2>/dev/null | grep -Fxq "    $REPO_DIR"; then
    echo "Pi package already points at $REPO_DIR"
  else
    pi install "$REPO_DIR"
  fi
}

needs_reload=false

if [ ! -d "$REPO_DIR/node_modules" ] || changed_any package.json package-lock.json; then
  echo "Syncing npm dependencies..."
  run_npm_install
  needs_reload=true
fi

ensure_skill_link "$REPO_DIR/skills" "$HOME/.claude/skills"
ensure_skill_link "$REPO_DIR/skills" "$HOME/.agents/skills"

ensure_pi_package_installed

if changed_any manifests/pi-packages.json; then
  if [ -x "$REPO_DIR/scripts/sync-pi-packages.sh" ]; then
    echo "Syncing third-party Pi packages..."
    "$REPO_DIR/scripts/sync-pi-packages.sh"
  else
    echo "scripts/sync-pi-packages.sh is missing or not executable; skipping third-party Pi package sync" >&2
  fi
  needs_reload=true
fi

if changed_any extensions skills prompts themes package.json package-lock.json manifests/pi-packages.json; then
  needs_reload=true
fi

if [ "$FORCE" = true ] || ! old_ref_is_valid; then
  echo "Agent tooling sync complete. Run /reload in active Pi sessions to pick up changes."
elif [ "$needs_reload" = true ]; then
  echo "Agent tooling sync complete. Run /reload in active Pi sessions to pick up changes."
else
  echo "Agent tooling sync complete. No Pi reload appears necessary."
fi
