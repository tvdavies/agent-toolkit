#!/usr/bin/env bash
set -euo pipefail

output=${1:-/tmp/pr-body.md}

cat > "$output" <<'EOF'
## Summary

- 

## Context


## Changes

- 

## Validation

Not run.

## Risk / Rollback

- Risk: 
- Rollback: 
EOF

echo "Wrote PR body template to $output"
echo "Edit it, then use: gh pr create --body-file $output"
