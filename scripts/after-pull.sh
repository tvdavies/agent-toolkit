#!/usr/bin/env bash
# Deprecated compatibility entrypoint for pre-existing Git hooks. Use scripts/sync.sh.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$SCRIPT_DIR/sync.sh" "$@"
