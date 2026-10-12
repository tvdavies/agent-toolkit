# shellcheck shell=bash
# Guided runbook library: the shared wizard behaviour for scripts an agent
# writes for Tom to run in his own terminal. Source it, don't execute it:
#
#   . "${WIZARD_LIB:-$HOME/.agents/skills/guided-runbook/scripts/lib/wizard.sh}"
#   wiz_init "Activate X on staging" 4
#
# Contract
# - Every change asks first and defaults to No. No stops the run cleanly; a
#   rerun detects finished steps and skips them.
# - Secrets come from 1Password at run time and live only in shell variables.
#   They are never printed, put on a command line or written to lasting files.
# - WIZ_DRY_RUN=1 runs preflight and detection only: every ask answers No
#   without prompting, so an agent can check a script before handing it over.
#
# Environment
#   INFRA             infrastructure checkout (default ~/dev/lleverage-ai/infrastructure)
#   WIZ_DRY_RUN       1 = read-only rehearsal
#   WIZ_LOG_DIR       where run logs go (default: the script's directory)
#   WIZ_TTY           prompt input (default /dev/tty; tests point it at a file)
#   OP_AGENT_ENV      1Password service-account env file (default ~/.config/op/agent.env)

set -euo pipefail

INFRA="${INFRA:-$HOME/dev/lleverage-ai/infrastructure}"
WIZ_DRY_RUN="${WIZ_DRY_RUN:-0}"
WIZ_TTY="${WIZ_TTY:-/dev/tty}"
OP_AGENT_ENV="${OP_AGENT_ENV:-$HOME/.config/op/agent.env}"
WIZ_TOTAL=0
WIZ_STEP=0
WIZ_TMP=""

if [[ -t 1 ]]; then
  _wb=$'\e[1m' _wg=$'\e[32m' _wy=$'\e[33m' _wr=$'\e[31m' _wd=$'\e[2m' _w0=$'\e[0m'
else
  _wb="" _wg="" _wy="" _wr="" _wd="" _w0=""
fi

# --- output -----------------------------------------------------------------

info() { printf '      %s\n' "$*"; }
ok()   { printf '  %sOK%s  %s\n' "$_wg" "$_w0" "$*"; }
skip() { printf '  %sSKIP%s %s\n' "$_wd" "$_w0" "$*"; }
warn() { printf '  %sWARN%s %s\n' "$_wy" "$_w0" "$*" >&2; }
die()  { printf '\n%sERROR:%s %s\n' "$_wr" "$_w0" "$*" >&2; exit 1; }

# wiz_init TITLE TOTAL_STEPS
# Strict mode, a private temp dir removed on exit, and a run log next to the
# script so Tom can paste it back if something goes wrong.
wiz_init() {
  local title="$1"
  WIZ_TOTAL="${2:-0}"
  WIZ_TMP="$(mktemp -d)"
  chmod 700 "$WIZ_TMP"
  trap '_wiz_exit $?' EXIT
  trap 'exit 130' INT TERM

  local script_dir log_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[1]:-$0}")" && pwd)"
  log_dir="${WIZ_LOG_DIR:-$script_dir}"
  if mkdir -p "$log_dir" 2>/dev/null && [[ -w "$log_dir" ]]; then
    WIZ_LOG="$log_dir/$(basename "${BASH_SOURCE[1]:-$0}" .sh).$(date +%Y%m%d-%H%M%S).log"
    exec > >(tee -a "$WIZ_LOG") 2>&1
  fi

  printf '\n%s%s%s\n' "$_wb" "$title" "$_w0"
  [[ "$WIZ_DRY_RUN" == 1 ]] && printf '%sDry run: checks only, every change is answered No.%s\n' "$_wy" "$_w0"
  [[ -n "${WIZ_LOG:-}" ]] && printf '%sLog: %s%s\n' "$_wd" "$WIZ_LOG" "$_w0"
  return 0
}

_wiz_exit() {
  local code="$1"
  [[ -n "$WIZ_TMP" ]] && rm -rf "$WIZ_TMP"
  if [[ "$code" -ne 0 && "$code" -ne 130 ]]; then
    printf '\n%sStopped with an error (exit %s).%s Fix the cause and run the same command again; finished steps are skipped.\n' "$_wr" "$code" "$_w0" >&2
    [[ -n "${WIZ_LOG:-}" ]] && printf 'Log: %s\n' "$WIZ_LOG" >&2
  fi
}

# step TITLE: numbered section header.
step() {
  WIZ_STEP=$((WIZ_STEP + 1))
  printf '\n%s=== Step %s/%s: %s ===%s\n' "$_wb" "$WIZ_STEP" "$WIZ_TOTAL" "$*" "$_w0"
}

# wiz_done [MESSAGE]: final summary.
wiz_done() {
  printf '\n%sAll steps done.%s %s\n' "$_wg" "$_w0" "${1:-}"
  [[ "$WIZ_DRY_RUN" == 1 ]] && printf '%s(Dry run: nothing was changed.)%s\n' "$_wy" "$_w0"
  return 0
}

# --- prompts ----------------------------------------------------------------

# ask QUESTION: yes/no, default No. Returns 0 only on y/Y.
ask() {
  local a=""
  if [[ "$WIZ_DRY_RUN" == 1 ]]; then
    printf '  >>> %s [y/N] %s(dry run: No)%s\n' "$1" "$_wd" "$_w0"
    return 1
  fi
  read -r -p "  >>> $1 [y/N] " a <"$WIZ_TTY" || true
  [[ "$a" =~ ^[Yy]$ ]]
}

# confirm_or_stop QUESTION: ask, and on No end the run cleanly (exit 0).
confirm_or_stop() {
  ask "$1" && return 0
  printf '\nStopped before changing anything else. Run the same command again to continue.\n'
  exit 0
}

# confirm_typed WORD QUESTION: for production or destructive changes, Tom
# must type WORD exactly. Anything else stops the run.
confirm_typed() {
  local word="$1" a=""
  if [[ "$WIZ_DRY_RUN" == 1 ]]; then
    printf '  >>> %s Type "%s" to continue: %s(dry run: stop)%s\n' "$2" "$word" "$_wd" "$_w0"
    printf '\nDry run ends here.\n'
    exit 0
  fi
  read -r -p "  >>> $2 Type \"$word\" to continue: " a <"$WIZ_TTY" || true
  [[ "$a" == "$word" ]] && return 0
  printf '\nStopped. Nothing else was changed.\n'
  exit 0
}

# pause_for MESSAGE: wait for Tom to finish something by hand.
pause_for() {
  if [[ "$WIZ_DRY_RUN" == 1 ]]; then
    printf '  >>> %s %s(dry run: not waiting)%s\n' "$1" "$_wd" "$_w0"
    return 0
  fi
  read -r -p "  >>> $1 Press Enter when done. " _ <"$WIZ_TTY" || true
}

# --- preflight --------------------------------------------------------------

# need_tools CMD...: fail early on anything missing.
need_tools() {
  local missing=() t
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  [[ ${#missing[@]} -eq 0 ]] || die "Missing tools: ${missing[*]}"
  ok "tools: $*"
}

# --- secrets ----------------------------------------------------------------
# Values go into a named variable and nowhere else. The 1Password token stays
# inside a subshell, so later commands (and the scripts they start) never see it.

_op() {
  [[ $- != *x* ]] || die "xtrace is on; refusing to load secrets"
  [[ -r "$OP_AGENT_ENV" ]] || die "No 1Password service-account env at $OP_AGENT_ENV (see the 1password skill)"
  # shellcheck disable=SC1090
  ( . "$OP_AGENT_ENV" && op "$@" )
}

# op_secret VAR 'op://Vault/Item/field'
op_secret() {
  local var="$1" ref="$2" value
  value="$(_op read "$ref")" || die "Couldn't read $ref from 1Password"
  [[ -n "$value" ]] || die "$ref is empty in 1Password"
  printf -v "$var" '%s' "$value"
}

# op_document_field VAR ITEM VAULT JQ_PATH: one field of a JSON document item.
op_document_field() {
  local var="$1" item="$2" vault="$3" path="$4" value
  # jq errors can quote the input, so they're dropped rather than logged.
  value="$(_op document get "$item" --vault "$vault" | jq -r "$path // empty" 2>/dev/null)" \
    || die "Couldn't read $path from 1Password document $item"
  [[ -n "$value" ]] || die "Document $item has no $path"
  printf -v "$var" '%s' "$value"
}

# openbao_root_token VAR ENV: current OpenBao root token (staging|production)
# from the "OpenBao init (<env>)" document in Infra break-glass. The local
# generated/<env>/openbao-init.json files are stale and deliberately removed.
openbao_root_token() {
  local var="$1" env="$2" item
  case "$env" in
    staging)    item=g2sj4oxhrub7gah3q5baq2x5ta ;;
    production) item=unnyxoishnelvedgduwuifu5ru ;;
    *) die "openbao_root_token: unknown environment '$env'" ;;
  esac
  op_document_field "$var" "$item" cvglmxwxawo3rvid64lwgwisk4 .root_token
  ok "OpenBao $env root token loaded from 1Password"
}

# --- cluster access ---------------------------------------------------------

# use_cluster ENV: export KUBECONFIG for staging|production and prove it works.
# Prefers the direct kubeconfig; falls back to kubeconfig.tailnet, whose SOCKS
# proxy (127.0.0.1:1055) sometimes fails single requests.
use_cluster() {
  local env="$1" dir cfg
  case "$env" in
    staging) dir="$INFRA/generated/staging" ;;
    production) dir="$INFRA/generated/production" ;;
    *) die "use_cluster: unknown environment '$env'" ;;
  esac
  for cfg in "${WIZ_KUBECONFIG:-}" "$dir/kubeconfig" "$dir/kubeconfig.tailnet"; do
    [[ -n "$cfg" && -r "$cfg" ]] || continue
    if KUBECONFIG="$cfg" kubectl version --request-timeout=10s >/dev/null 2>&1; then
      export KUBECONFIG="$cfg"
      ok "$env cluster reachable ($(basename "$cfg"))"
      return 0
    fi
    warn "$cfg didn't answer; trying the next kubeconfig"
  done
  die "Can't reach the $env cluster with any kubeconfig in $dir"
}

# --- OpenBao ----------------------------------------------------------------

OPENBAO_POD="${OPENBAO_POD:-}"

# openbao_connect TOKEN_VAR: find the active pod and check the token's policy.
openbao_connect() {
  BAO_TOKEN_VAR="$1"
  if [[ -z "$OPENBAO_POD" ]]; then
    OPENBAO_POD="$(kubectl -n openbao get pods -l openbao-active=true -o name | awk 'NR == 1')"
    OPENBAO_POD="${OPENBAO_POD#pod/}"
  fi
  [[ -n "$OPENBAO_POD" ]] || die "No active OpenBao pod in namespace openbao (set OPENBAO_POD)"
  local policies
  policies="$(bao token lookup -format=json | jq -c .data.policies)" \
    || die "OpenBao rejected the token"
  ok "OpenBao pod openbao/$OPENBAO_POD, token policies $policies"
}

# bao ARGS...: run bao inside the active pod. The token travels on stdin, so
# it never appears in a process list or the log.
bao() { bao_with_input /dev/null "$@"; }

# bao_with_input FILE ARGS...: same, with FILE as bao's stdin after the token
# line, e.g. `bao_with_input "$WIZ_TMP/new.hcl" policy write external-secrets -`.
bao_with_input() {
  local input="$1"; shift
  [[ -n "${BAO_TOKEN_VAR:-}" ]] || die "bao: call openbao_connect first"
  { printf '%s\n' "${!BAO_TOKEN_VAR}"; cat "$input"; } \
    | kubectl -n openbao exec -i "$OPENBAO_POD" -- sh -c \
      'IFS= read -r BAO_TOKEN; export BAO_TOKEN BAO_ADDR=http://127.0.0.1:8202; exec bao "$@"' sh "$@"
}

# --- safe changes -----------------------------------------------------------

# show_cmd DESCRIPTION CMD...: print what will run, then run it.
show_cmd() {
  local desc="$1"; shift
  printf '  %s$ %s%s\n' "$_wd" "$*" "$_w0"
  "$@" || die "$desc failed"
}

# guard_nonempty FILE WHAT: refuse to continue on an empty read, so a failed
# read can never turn into a write that replaces the whole object.
guard_nonempty() {
  [[ -s "$1" ]] || die "$2 came back empty; refusing to write anything based on it"
}

# guard_additive BEFORE AFTER: show the diff and refuse if it removes or
# changes any existing line. Returns 1 when there is nothing to change.
guard_additive() {
  local before="$1" after="$2" status=0 removed
  [[ -r "$before" && -r "$after" ]] || die "guard_additive: can't read $before or $after"
  diff "$before" "$after" >"$WIZ_TMP/.guard.diff" || status=$?
  case "$status" in
    0) return 1 ;;
    1) ;;
    *) die "guard_additive: diff failed (exit $status); refusing" ;;
  esac
  sed 's/^/      /' "$WIZ_TMP/.guard.diff"
  removed="$(grep -c '^<' "$WIZ_TMP/.guard.diff" || true)"
  [[ "$removed" -eq 0 ]] || die "This change would remove $removed existing lines; refusing"
  return 0
}

# guard_unchanged SNAPSHOT CURRENT WHAT: call after the confirmation, with a
# fresh read in CURRENT. Stops if someone changed the object while Tom was
# deciding, so the write can't drop their change.
guard_unchanged() {
  guard_nonempty "$2" "$3 re-read"
  cmp -s "$1" "$2" || die "$3 changed while waiting for confirmation; run again to rebuild the change"
}
