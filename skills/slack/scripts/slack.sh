#!/usr/bin/env bash
set -euo pipefail

# Slack API wrapper using xoxc/xoxd browser tokens
# Auth: SLACK_MCP_XOXC_TOKEN (Bearer) + SLACK_MCP_XOXD_TOKEN (cookie d=)

XOXC="${SLACK_MCP_XOXC_TOKEN:?SLACK_MCP_XOXC_TOKEN not set}"
XOXD="${SLACK_MCP_XOXD_TOKEN:?SLACK_MCP_XOXD_TOKEN not set}"

slack_api() {
  local method="$1"
  shift
  curl -s "https://slack.com/api/$method" \
    -H "Authorization: Bearer $XOXC" \
    -b "d=$XOXD" \
    "$@"
}

slack_post() {
  local method="$1"
  shift
  curl -s "https://slack.com/api/$method" \
    -H "Authorization: Bearer $XOXC" \
    -H "Content-Type: application/json; charset=utf-8" \
    -b "d=$XOXD" \
    "$@"
}

check_error() {
  local resp="$1"
  local ok
  ok=$(echo "$resp" | jq -r '.ok')
  if [ "$ok" != "true" ]; then
    local err
    err=$(echo "$resp" | jq -r '.error // "unknown error"')
    echo "Error: $err" >&2
    return 1
  fi
}

# ─── Commands ──────────────────────────────────────────────

cmd_profile() {
  local resp
  resp=$(slack_api "auth.test")
  check_error "$resp"
  echo "$resp" | jq '{user: .user, team: .team, user_id: .user_id, team_id: .team_id, url: .url}'
}

cmd_channels() {
  local types="${1:-public_channel,private_channel}"
  local limit="${2:-200}"
  local cursor=""
  local all_channels="[]"

  while true; do
    local params="types=$types&limit=$limit&exclude_archived=true"
    [ -n "$cursor" ] && params="$params&cursor=$cursor"

    local resp
    resp=$(slack_api "conversations.list" -d "$params")
    check_error "$resp"

    local batch
    batch=$(echo "$resp" | jq '[.channels[] | {id: .id, name: .name, is_private: .is_private, is_im: .is_im, is_mpim: .is_mpim, num_members: .num_members, topic: .topic.value, purpose: .purpose.value}]')
    all_channels=$(echo "$all_channels $batch" | jq -s 'add')

    cursor=$(echo "$resp" | jq -r '.response_metadata.next_cursor // ""')
    [ -z "$cursor" ] && break
  done

  echo "$all_channels" | jq -r '.[] | "\(.id)\t\(.name)\t\(if .is_private then "private" elif .is_im then "dm" elif .is_mpim then "group_dm" else "public" end)\tmembers:\(.num_members // "-")"'
}

cmd_history() {
  local channel="${1:?Usage: slack.sh history <channel_id> [limit]}"
  local limit="${2:-20}"

  local resp
  resp=$(slack_api "conversations.history" -d "channel=$channel&limit=$limit")
  check_error "$resp"

  echo "$resp" | jq -r '.messages[] | "\(.ts) | \(.user // .bot_id // "system") | \(.text // "[no text]")[0:500]"'
}

cmd_thread() {
  local channel="${1:?Usage: slack.sh thread <channel_id> <thread_ts>}"
  local ts="${2:?Usage: slack.sh thread <channel_id> <thread_ts>}"

  local resp
  resp=$(slack_api "conversations.replies" -d "channel=$channel&ts=$ts&limit=100")
  check_error "$resp"

  echo "$resp" | jq -r '.messages[] | "\(.ts) | \(.user // .bot_id // "system") | \(.text // "[no text]")[0:500]"'
}

cmd_send() {
  local channel="${1:?Usage: slack.sh send <channel_id> <text|-> [thread_ts]}"
  local text="${2:?Usage: slack.sh send <channel_id> <text|-> [thread_ts]}"
  local thread_ts="${3:-}"

  if [ "$text" = "-" ]; then
    text=$(cat)
  fi

  local payload
  payload=$(jq -n --arg ch "$channel" --arg txt "$text" '{channel: $ch, text: $txt}')
  if [ -n "$thread_ts" ]; then
    payload=$(echo "$payload" | jq --arg ts "$thread_ts" '. + {thread_ts: $ts}')
  fi

  local resp
  resp=$(slack_post "chat.postMessage" -d "$payload")
  check_error "$resp"

  echo "$resp" | jq '{ok: .ok, channel: .channel, ts: .ts}'
}

cmd_search() {
  local query="${1:?Usage: slack.sh search <query> [count]}"
  local count="${2:-20}"

  local resp
  resp=$(slack_api "search.messages" -d "query=$query&count=$count&sort=timestamp&sort_dir=desc")
  check_error "$resp"

  echo "$resp" | jq -r '.messages.matches[] | "\(.channel.name) | \(.ts) | \(.username // .user // "unknown") | \(.text // "[no text]")[0:300]"'
}

cmd_users() {
  local query="${1:-}"

  if [ -z "$query" ]; then
    # List all users (non-bot, non-deleted)
    local resp
    resp=$(slack_api "users.list" -d "limit=200")
    check_error "$resp"
    echo "$resp" | jq -r '.members[] | select(.deleted == false and .is_bot == false and .id != "USLACKBOT") | "\(.id)\t\(.name)\t\(.real_name // "-")\t\(.profile.email // "-")"'
  else
    # Search users
    local resp
    resp=$(slack_api "users.list" -d "limit=500")
    check_error "$resp"
    echo "$resp" | jq -r --arg q "$query" '.members[] | select(.deleted == false and (.name | test($q; "i")) or (.real_name // "" | test($q; "i")) or (.profile.email // "" | test($q; "i"))) | "\(.id)\t\(.name)\t\(.real_name // "-")\t\(.profile.email // "-")"'
  fi
}

cmd_mark() {
  local channel="${1:?Usage: slack.sh mark <channel_id> [ts]}"
  local ts="${2:-}"

  if [ -z "$ts" ]; then
    # Get latest message ts
    local hist
    hist=$(slack_api "conversations.history" -d "channel=$channel&limit=1")
    check_error "$hist"
    ts=$(echo "$hist" | jq -r '.messages[0].ts // ""')
    if [ -z "$ts" ]; then
      echo "No messages in channel"
      return 0
    fi
  fi

  local resp
  resp=$(slack_post "conversations.mark" -d "$(jq -n --arg ch "$channel" --arg ts "$ts" '{channel: $ch, ts: $ts}')")
  check_error "$resp"
  echo "Marked $channel as read up to $ts"
}

cmd_groups() {
  local resp
  resp=$(slack_api "usergroups.list" -d "include_count=true&include_users=false")
  check_error "$resp"

  echo "$resp" | jq -r '.usergroups[] | "\(.id)\t@\(.handle)\t\(.name)\tusers:\(.user_count // 0)"'
}

cmd_unreads() {
  local types="${1:-public_channel,private_channel,im,mpim}"

  # Get subscribed channels
  local resp
  resp=$(slack_api "users.conversations" -d "types=$types&limit=200&exclude_archived=true")
  check_error "$resp"

  local channels
  channels=$(echo "$resp" | jq -r '.channels[].id')

  local found=0
  for ch_id in $channels; do
    local info
    info=$(slack_api "conversations.info" -d "channel=$ch_id")
    local unread_count
    unread_count=$(echo "$info" | jq -r '.channel.unread_count // 0')
    if [ "$unread_count" != "0" ] && [ "$unread_count" != "null" ]; then
      local ch_name
      ch_name=$(echo "$info" | jq -r '.channel.name // .channel.id')
      local last_read
      last_read=$(echo "$info" | jq -r '.channel.last_read // ""')

      echo "--- $ch_name ($ch_id) --- $unread_count unread ---"

      # Fetch unread messages (after last_read)
      local msgs
      if [ -n "$last_read" ] && [ "$last_read" != "null" ]; then
        msgs=$(slack_api "conversations.history" -d "channel=$ch_id&oldest=$last_read&limit=10")
      else
        msgs=$(slack_api "conversations.history" -d "channel=$ch_id&limit=$unread_count")
      fi
      echo "$msgs" | jq -r '.messages[]? | "  \(.ts) | \(.user // .bot_id // "system") | \(.text // "[no text]")[0:200]"' 2>/dev/null
      echo ""
      found=$((found + 1))
    fi
  done

  if [ "$found" -eq 0 ]; then
    echo "No unread messages"
  fi
}

cmd_edit() {
  local channel="${1:?Usage: slack.sh edit <channel_id> <timestamp> <new_text|->}"
  local ts="${2:?Usage: slack.sh edit <channel_id> <timestamp> <new_text|->}"
  local text="${3:?Usage: slack.sh edit <channel_id> <timestamp> <new_text|->}"

  if [ "$text" = "-" ]; then
    text=$(cat)
  fi

  local resp
  resp=$(slack_post "chat.update" -d "$(jq -n --arg ch "$channel" --arg ts "$ts" --arg txt "$text" '{channel: $ch, ts: $ts, text: $txt}')")
  check_error "$resp"
  echo "$resp" | jq '{ok: .ok, channel: .channel, ts: .ts}'
}

cmd_delete() {
  local channel="${1:?Usage: slack.sh delete <channel_id> <timestamp>}"
  local ts="${2:?Usage: slack.sh delete <channel_id> <timestamp>}"

  local resp
  resp=$(slack_post "chat.delete" -d "$(jq -n --arg ch "$channel" --arg ts "$ts" '{channel: $ch, ts: $ts}')")
  check_error "$resp"
  echo "Deleted message $ts from $channel"
}

cmd_unreact() {
  local channel="${1:?Usage: slack.sh unreact <channel_id> <timestamp> <emoji_name>}"
  local ts="${2:?Usage: slack.sh unreact <channel_id> <timestamp> <emoji_name>}"
  local emoji="${3:?Usage: slack.sh unreact <channel_id> <timestamp> <emoji_name>}"

  emoji="${emoji#:}"
  emoji="${emoji%:}"

  local resp
  resp=$(slack_post "reactions.remove" -d "$(jq -n --arg ch "$channel" --arg ts "$ts" --arg name "$emoji" '{channel: $ch, timestamp: $ts, name: $name}')")
  check_error "$resp"
  echo "Removed :$emoji: from $channel @ $ts"
}

cmd_userinfo() {
  local user_id="${1:?Usage: slack.sh userinfo <user_id>}"

  local resp
  resp=$(slack_api "users.info" -d "user=$user_id")
  check_error "$resp"
  echo "$resp" | jq -r '.user | "\(.id)\t\(.name)\t\(.real_name // "-")\t\(.profile.email // "-")\t\(.profile.title // "-")"'
}

cmd_react() {
  local channel="${1:?Usage: slack.sh react <channel_id> <timestamp> <emoji_name>}"
  local ts="${2:?Usage: slack.sh react <channel_id> <timestamp> <emoji_name>}"
  local emoji="${3:?Usage: slack.sh react <channel_id> <timestamp> <emoji_name>}"

  # Strip colons if provided (e.g. :thumbsup: -> thumbsup)
  emoji="${emoji#:}"
  emoji="${emoji%:}"

  local resp
  resp=$(slack_post "reactions.add" -d "$(jq -n --arg ch "$channel" --arg ts "$ts" --arg name "$emoji" '{channel: $ch, timestamp: $ts, name: $name}')")
  check_error "$resp"
  echo "Added :$emoji: to $channel @ $ts"
}

cmd_resolve_channel() {
  # Helper: resolve #name or @user to channel ID
  local input="${1:?Usage: slack.sh resolve <#channel|@user|channel_id>}"

  if [[ "$input" =~ ^C[A-Z0-9]+$ ]] || [[ "$input" =~ ^D[A-Z0-9]+$ ]] || [[ "$input" =~ ^G[A-Z0-9]+$ ]]; then
    echo "$input"
    return
  fi

  # Strip leading # or @
  local name="${input#\#}"
  name="${name#@}"

  if [[ "$input" == @* ]]; then
    # Find DM channel for user
    local users_resp
    users_resp=$(slack_api "users.list" -d "limit=500")
    local user_id
    user_id=$(echo "$users_resp" | jq -r --arg n "$name" '.members[] | select(.name == $n or .real_name == $n) | .id' | head -1)
    if [ -z "$user_id" ]; then
      echo "User not found: $name" >&2
      return 1
    fi
    local dm_resp
    dm_resp=$(slack_post "conversations.open" -d "$(jq -n --arg u "$user_id" '{users: $u}')")
    check_error "$dm_resp"
    echo "$dm_resp" | jq -r '.channel.id'
  else
    # Find channel by name
    local ch_resp
    ch_resp=$(slack_api "conversations.list" -d "types=public_channel,private_channel&limit=500&exclude_archived=true")
    local ch_id
    ch_id=$(echo "$ch_resp" | jq -r --arg n "$name" '.channels[] | select(.name == $n) | .id' | head -1)
    if [ -z "$ch_id" ]; then
      echo "Channel not found: $name" >&2
      return 1
    fi
    echo "$ch_id"
  fi
}

# ─── Main ──────────────────────────────────────────────────

usage() {
  cat <<'USAGE'
Usage: slack.sh <command> [args...]

Commands:
  profile                           Show current user identity
  channels [type]                   List channels (public_channel,private_channel,im,mpim)
  history <channel> [limit]         Read channel messages (default: 20)
  thread <channel> <thread_ts>      Read thread replies
  send <channel> <text|-> [thread_ts]
                                    Send a message; use '-' to read text from stdin
  search <query> [count]            Search messages
  users [query]                     List or search users
  mark <channel> [ts]               Mark channel as read
  groups                            List user groups
  unreads [type]                    Show channels with unread messages
  edit <channel> <ts> <new_text|->   Edit a message; use '-' to read text from stdin
  delete <channel> <ts>             Delete a message
  react <channel> <ts> <emoji>      Add emoji reaction to a message
  unreact <channel> <ts> <emoji>    Remove emoji reaction from a message
  userinfo <user_id>                Get user details by ID
  resolve <#channel|@user|id>       Resolve name to channel ID

Channel can be an ID (C...) or use 'resolve' first to convert #name/@user.
USAGE
}

case "${1:-}" in
  profile)  shift; cmd_profile "$@" ;;
  channels) shift; cmd_channels "$@" ;;
  history)  shift; cmd_history "$@" ;;
  thread)   shift; cmd_thread "$@" ;;
  send)     shift; cmd_send "$@" ;;
  search)   shift; cmd_search "$@" ;;
  users)    shift; cmd_users "$@" ;;
  mark)     shift; cmd_mark "$@" ;;
  groups)   shift; cmd_groups "$@" ;;
  unreads)  shift; cmd_unreads "$@" ;;
  edit)     shift; cmd_edit "$@" ;;
  delete)   shift; cmd_delete "$@" ;;
  react)    shift; cmd_react "$@" ;;
  unreact)  shift; cmd_unreact "$@" ;;
  userinfo) shift; cmd_userinfo "$@" ;;
  resolve)  shift; cmd_resolve_channel "$@" ;;
  help|--help|-h|"") usage ;;
  *) echo "Unknown command: $1" >&2; usage >&2; exit 1 ;;
esac
