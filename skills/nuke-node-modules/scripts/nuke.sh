#!/usr/bin/env bash
# Fast, safe node_modules removal: instant rename, then idle-priority background delete.
# Usage: nuke.sh [dir ...]   (defaults to ./node_modules)
set -euo pipefail

targets=("${@:-node_modules}")

for target in "${targets[@]}"; do
  if [ ! -d "$target" ]; then
    echo "skip: $target (not a directory)"
    continue
  fi
  case "$(basename "$target")" in
    node_modules|.node_modules-partial|node_modules.trash*|.trash-*) ;;
    *)
      echo "refusing to delete '$target': not a node_modules-like directory" >&2
      exit 1
      ;;
  esac
  trash="$(dirname "$target")/.trash-node_modules-$$-$RANDOM"
  mv "$target" "$trash"
  setsid ionice -c3 nice -n 19 rm -rf "$trash" >/dev/null 2>&1 &
  echo "moved: $target -> $trash (deleting in background, idle I/O priority)"
done
