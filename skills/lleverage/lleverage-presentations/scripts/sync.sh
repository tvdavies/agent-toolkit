#!/usr/bin/env bash
# Fetch or refresh the private Lleverage brand kit into a local cache.
#
#   sync.sh            clone on first use, otherwise update to the latest commit
#   sync.sh --check    report the cached version against the design system, change nothing
#
# The brand material (stylesheet, templates, fonts, logos, icons, voice rules) is
# private and never lives in this public repository. The canonical copy is the
# `lleverage-presentations` and `lleverage-content-voice` skills in
# lleverage-ai/delta-agent; the design system (lleverage-ai/lleverage-design-system)
# generates the kit inside them. This script keeps a sparse, shallow checkout of
# just those two directories.
#
# Environment:
#   LLEVERAGE_PRESENTATIONS_HOME  cache root (default ~/.cache/lleverage-presentations)
#   LLEVERAGE_DELTA_AGENT_URL     clone URL (default git@github.com:lleverage-ai/delta-agent.git)
set -euo pipefail

home="${LLEVERAGE_PRESENTATIONS_HOME:-$HOME/.cache/lleverage-presentations}"
repo="$home/delta-agent"
url="${LLEVERAGE_DELTA_AGENT_URL:-git@github.com:lleverage-ai/delta-agent.git}"
kit_rel="plugins/delta/skills/lleverage-presentations"
voice_rel="plugins/delta/skills/lleverage-content-voice"
check_only=false
[[ "${1:-}" == "--check" ]] && check_only=true

if ! $check_only; then
  if [[ ! -d "$repo/.git" ]]; then
    mkdir -p "$home"
    echo "cloning $url (sparse) into $repo"
    git clone --quiet --depth 1 --filter=blob:none --sparse "$url" "$repo"
  fi
  git -C "$repo" sparse-checkout set "$kit_rel" "$voice_rel"
  # The cache is managed by this script and never edited, so it always moves to the
  # remote head rather than merging.
  git -C "$repo" fetch --quiet --depth 1 origin HEAD
  git -C "$repo" reset --quiet --hard FETCH_HEAD
fi

if [[ ! -f "$repo/$kit_rel/system/SYSTEM-VERSION.json" ]]; then
  echo "no kit at $repo/$kit_rel; run sync.sh without --check" >&2
  exit 1
fi

read_version() { node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(`${v.version} ${v.generated} ${v.tokensDigest}`)'; }
read -r version generated digest < <(read_version < "$repo/$kit_rel/system/SYSTEM-VERSION.json")
commit="$(git -C "$repo" log -1 --format='%h %cs')"
echo "kit $version (generated $generated, tokens $digest) from delta-agent $commit"
echo "kit:   $repo/$kit_rel"
echo "voice: $repo/$voice_rel"

# The design system is the source of the kit. If its published version has moved on,
# the delta-agent copy is stale and deliverables would be composed against old tokens.
if command -v gh >/dev/null 2>&1; then
  if upstream="$(gh api repos/lleverage-ai/lleverage-design-system/contents/kit/SYSTEM-VERSION.json \
      -H 'Accept: application/vnd.github.raw' 2>/dev/null | read_version)"; then
    read -r up_version up_generated up_digest <<<"$upstream"
    if [[ "$up_digest" == "$digest" ]]; then
      echo "design system: $up_version, matches"
    else
      echo "WARNING: design system is at $up_version ($up_generated, tokens $up_digest) but the kit is $version." >&2
      echo "WARNING: the delta-agent copy is stale. Say so before composing, and ask the design owner to refresh it." >&2
    fi
  else
    echo "design system version not checked (gh api failed)" >&2
  fi
fi
