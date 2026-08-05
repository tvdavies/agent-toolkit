#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../_shared/pr-readiness/scripts" && pwd)"
exec "$script_dir/reply-and-resolve.sh" "$@"
