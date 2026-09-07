#!/usr/bin/env bash
# Allocate once per review. An explicit caller directory is caller-owned.
set -euo pipefail
umask 077
if [[ -n "${PR_REVIEW_TMPDIR:-}" ]]; then
    mkdir -p -- "$PR_REVIEW_TMPDIR"
    cd -- "$PR_REVIEW_TMPDIR"
    pwd -P
else
    directory=$(mktemp -d "${TMPDIR:-/tmp}/pr-review.XXXXXXXX")
    cd -- "$directory"
    pwd -P
fi
