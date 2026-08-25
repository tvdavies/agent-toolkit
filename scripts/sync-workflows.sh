#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_DIR="${AGENT_TOOLS_DIR:-$DEFAULT_REPO_DIR}"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
SOURCE_DIR="$REPO_DIR/.pi/workflows"
DEST_DIR="$HOME/.pi/agent/workflows"
STATE_FILE="$HOME/.local/state/agent-toolkit/workflow-links.txt"

mkdir -p "$DEST_DIR" "$(dirname "$STATE_FILE")"
mapfile -t desired < <(find "$SOURCE_DIR" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.js' \) -printf '%f\n' | sort)
mapfile -t previous < <(cat "$STATE_FILE" 2>/dev/null || true)

for name in "${previous[@]}"; do
  [ -n "$name" ] || continue
  if printf '%s\n' "${desired[@]}" | grep -Fxq "$name"; then continue; fi
  destination="$DEST_DIR/$name"
  if [ -L "$destination" ]; then
    target="$(readlink -f "$destination" 2>/dev/null || true)"
    case "$target" in "$REPO_DIR"/*) rm "$destination"; echo "Removed stale managed workflow $name" ;; esac
  fi
done

for name in "${desired[@]}"; do
  source="$SOURCE_DIR/$name"
  destination="$DEST_DIR/$name"
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    if [ ! -L "$destination" ]; then
      echo "$destination exists and is not a symlink; refusing to overwrite unmanaged content" >&2
      exit 1
    fi
    target="$(readlink -f "$destination" 2>/dev/null || true)"
    if [ "$target" = "$source" ]; then continue; fi
    case "$target" in
      "$REPO_DIR"/*) rm "$destination" ;;
      *) echo "$destination points outside this toolkit; refusing to overwrite it" >&2; exit 1 ;;
    esac
  fi
  ln -s "$source" "$destination"
  echo "Linked saved workflow $name"
done

printf '%s\n' "${desired[@]}" > "$STATE_FILE"
