#!/usr/bin/env bash
# Usage: check-runbook.sh [--dry-run] SCRIPT
# Checks a guided runbook before it is handed to Tom: syntax, shellcheck, the
# wizard contract and secret-handling rules. --dry-run also rehearses it with
# WIZ_DRY_RUN=1 (preflight and detection only; every change answers No).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dry=0
[[ "${1:-}" == "--dry-run" ]] && { dry=1; shift; }
script="${1:?Usage: check-runbook.sh [--dry-run] SCRIPT}"
[[ -r "$script" ]] || { echo "Can't read $script" >&2; exit 2; }

fail=0
bad() { printf 'FAIL %s\n' "$*"; fail=1; }
good() { printf 'ok   %s\n' "$*"; }

if bash -n "$script"; then good "bash syntax"; else bad "bash syntax"; fi

if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -x -P "$here/lib" -e SC1090,SC1091 "$script"; then good "shellcheck"; else bad "shellcheck"; fi
else
  printf 'warn shellcheck not installed; skipped\n'
fi

src="$(grep -v '^[[:space:]]*#' "$script")"
check() { # check DESCRIPTION REGEX should-match(1|0)
  local found=0
  if grep -qE -- "$2" <<<"$src"; then found=1; fi
  if [[ "$found" == "$3" ]]; then good "$1"; else bad "$1"; fi
}
check "sources the wizard library" 'guided-runbook/scripts/lib/wizard\.sh' 1
check "calls wiz_init" '^[[:space:]]*wiz_init ' 1
check "no fish-only syntax (read -gsx, set -x VAR)" 'read -[a-z]*g[a-z]*sx|^[[:space:]]*set -[gx]+ [A-Z_]+ ' 0
check "no local OpenBao init files (use openbao_root_token)" 'openbao-init\.json' 0
check "no --reveal or raw 1Password token handling" '--reveal|OP_SERVICE_ACCOUNT_TOKEN' 0
check "no xtrace (would print secrets)" '(^|[;&|[:space:]])set[[:space:]]+(-[a-zA-Z]*x|.*-o[[:space:]]*xtrace)|BASH_XTRACEFD|bash -[a-z]*x' 0
check "no secret values on the command line (BAO_TOKEN=...)" 'BAO_TOKEN=[^ ]|VAULT_TOKEN=' 0
check "no bare read prompts (use ask/confirm_or_stop)" '(^|[;&|[:space:]])read -r -p' 0

if [[ "$dry" == 1 && "$fail" == 0 ]]; then
  printf '\n--- dry run ---\n'
  if WIZ_DRY_RUN=1 WIZ_TTY=/dev/null WIZ_LOG_DIR="$(mktemp -d)" bash "$script" </dev/null; then
    good "dry run"
  else
    bad "dry run"
  fi
fi

if [[ "$fail" != 0 ]]; then echo "check-runbook: failed"; exit 1; fi
echo "check-runbook: passed"
