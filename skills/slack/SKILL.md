---
name: slack
description: Interact with Slack workspaces using API scripts. Use when the user says "send a slack message", "check slack", "read slack messages", "search slack", "slack unreads", "list channels", "check DMs", "reply in thread", "who sent this on slack", "mark as read", or any Slack-related request. Capabilities include listing channels, reading message history, getting thread replies, sending messages, searching messages, finding users, marking channels read, listing user groups, and checking unreads.
metadata:
  author: tvd
  version: 1.0.0
---

# Slack

Interact with Slack using the skill-local script `scripts/slack.sh` (calls Slack API directly via `SLACK_MCP_XOXC_TOKEN` / `SLACK_MCP_XOXD_TOKEN`). When invoking it from outside this skill directory, use the absolute path `/home/tvd/.claude/skills/slack/scripts/slack.sh` or resolve paths relative to this SKILL.md file. Do not search the filesystem for the script.

## Important: Agent Conventions

- Always resolve `#channel-name` or `@username` to a channel ID first using `slack.sh resolve <name>` before passing to other commands.
- **Never guess user identities from IDs.** Always resolve user IDs to names using `slack.sh userinfo <user_id>` before attributing messages to anyone. Do not assume a user ID belongs to a particular person — look it up every time.
- When displaying messages to the user, format them readably with timestamps, usernames, and content.
- For sending messages, always confirm with the user before executing `slack.sh send`, unless the user explicitly asks you to send a specific message immediately.
- For multiline Slack messages, do **not** pass literal `\n` sequences inside a normal quoted shell argument. Slack will receive backslash+n text instead of real line breaks. Use stdin with `send ... -` / `edit ... -` and a quoted heredoc, or use Bash ANSI-C quoting (`$'line 1\nline 2'`). Prefer the stdin heredoc pattern for reliability.
- Channel IDs look like `C...` (channels), `D...` (DMs), `G...` (group DMs/private channels).

## Voice & Style Guide

When drafting or sending messages as Tom, follow these rules to match his authentic writing style.

### Core Voice: Direct, casual-professional, pragmatic

**Message Length — short by default, long only when it matters**
- Default is 1-10 words: "Yes", "looks awesome", "interesting....", "Not tried it in Codex yet"
- Medium (1-2 sentences) for status/context: "There is a unit test failing. Added a review."
- Long (paragraph+) only for architecture decisions, rationale, process concerns, or nuanced opinions — even then, sentences stay short and punchy
- In DMs/group DMs, break complex thoughts into multiple sequential short messages rather than composing one wall of text

**Sentence Structure**
- Short, declarative. Fragments are common and fine: "Claude Code", "problem with vibed ux changes"
- Questions are direct: "You pushed everything up so I can look?", "Did you see comments on this one?"
- Often open with "I think", "Basically", "Anyway", "To be honest", "I don't think"
- No full stops on short messages (under ~8 words). Full stops on longer ones.

**Tone**
- Lead with the point — no greetings, no preamble
- Comfortable mixing technical depth with casual language in the same message
- Self-aware, occasionally self-deprecating: "OK... this is stupid of me not to notice", "To be honest, I keep going around in circles on this! Don't know what I want."
- Warm but not effusive — use humour to connect, not flattery
- Soften requests casually: "When you get a mo, can you look at this PR?"
- Diplomatic when raising concerns — state position clearly but acknowledge others: "I'm not trying to point fingers. I know that Alex and Dean are doing their best with what they've got."

**Longer-Form Writing (when explaining decisions, process, or architecture)**
- Use "we" language (team-oriented): "I think we should...", "we need to make sure..."
- Structure arguments logically: state the problem, give reasoning, propose a solution
- Use bullet points for structured options/proposals, but prose for general argumentation
- Quote or reference others' words when building on their point
- Acknowledge complexity honestly: "It's hard to say because...", "I'm not saying that this is how it should be; just this is how I think we decided to initially implement this."
- Often wrap up longer messages with a clear position: "I think that's the starting point. And then we see what's really needed on top of that."

### Formatting Rules

**Emoji: Sparse, purposeful (0-1 per message, most messages have none)**
- `:slightly_smiling_face:` — most used, to soften a statement that could read as blunt
- `:joy:` — genuine amusement
- `:thinking_face:` — curiosity or mild puzzlement
- `:smile:` — friendly acknowledgment
- `:rotating_light:` — urgency tag for PRs needing immediate attention
- Seasonal emoji only for social messages
- Never emoji-heavy. Never multiple emoji in a row (except seasonal greetings).

**Punctuation**
- Ellipsis for trailing thought or uncertainty: "interesting....", "If you haven't really got past 20% yet, then on the old context window you wouldn't have hit compaction..."
- Exclamation marks sparingly and genuinely — for real emphasis or humour, not enthusiasm-signaling
- Proper capitalisation generally, but lowercase fine for rapid-fire quick messages
- "lol" used occasionally in casual contexts (DMs, group chats), standalone or at end of message

**Links**
- Often share a link as the entire message with no commentary
- Or 1 line of context before/after the link — let the link speak for itself
- Pattern: "When you get a mo, can you look at this PR?\n<link>\n\nThis should resolve the downtime issues."
- PR channel announcements: `ticket(scope): short description\n<link>` — nothing more
- Reference Linear issues and GitHub PRs by URL, not by describing them

**Code & Structure**
- Triple backticks for technical content (logs, config, code)
- Bullet points only for structured proposals (listing options, steps, features) — not for general writing
- No bold, no headers, no heavy formatting in Slack messages
- Keep formatting flat and conversational

### Context-Specific Rules

**Channels (public)**: Concise updates, questions, PR links. Observational commentary that's genuine, not performative. Sometimes share articles/links with a reflective paragraph connecting it to the team's experience.

**Thread replies**: Respond to the specific point — don't recap. Give options when providing technical guidance, not mandates ("What we could do is: ..."). Acknowledge gaps honestly ("It's hard to say because..."). End threads with clear next actions: "Indeed. Will sort that.", "I will continue to look into this one."

**DMs / Group DMs**: More informal — "lol", "hey ho" (resignation/acceptance). Stream-of-consciousness thinking across multiple messages. Comfortable thinking out loud: "I'm trying to explain what I want", "I keep going around in circles on this!" Quick back-and-forth with single-word or 2-3 word messages.

**PR / Bug channels**: Factual and terse. "There is a unit test failing. Added a review." For new PRs and PR reactions, follow the conventions in `references/pull-requests.md`. Ping specific people with `:rotating_light:` for urgent reviews.

**Raising process/team concerns**: Frame diplomatically. State the problem, give reasoning, propose solution. Use "I think we need..." not demands. Acknowledge others' efforts while being direct about the issue.

### Anti-Patterns (never do these)
- No "Hey!", "Hi team!", greeting preambles, or sign-offs
- No "Hope you're well" or social niceties before getting to the point
- No "just wanted to..." hedging — state things directly
- No excessive exclamation marks or faux enthusiasm
- No padding short answers — "Yes" not "Yes, that sounds good to me!"
- No numbered lists or heavy formatting in casual messages
- No corporate jargon or buzzwords
- No emoji reactions as substitutes for written replies
- Never say "fml", "lmao", "shizzle", or similar — those are other people's vocabulary
- Don't over-qualify or hedge excessively — state views and acknowledge uncertainty honestly rather than softening everything

### Distinctive Phrases (use naturally when appropriate)
- "I think..." / "I don't think..." — considered opinion, used frequently
- "Basically, ..." — simplifying complex things
- "Anyway, ..." — transitioning or wrapping up a tangent
- "To be honest, ..." — candid admission
- "Am I missing something..." — genuine question, not passive-aggressive
- "Indeed. Will sort that." — concise acknowledgment + commitment to action
- "I will continue to look into this one" — follow-through commitment
- "It's easy to know what it's not. Hard to know what it is." — reflective/philosophical
- "When you get a mo, ..." — casual request softener
- "I'm not trying to point fingers" — diplomatic framing before a concern
- "I think that's the starting point. And then we see what's really needed on top of that." — pragmatic wrap-up

## Reference Files

Channel-specific conventions are documented in `references/`. Consult these when working with the relevant channel:

- **`references/pull-requests.md`** — PR posting format, review reaction conventions, and tagging rules for `#pull-requests`

## Commands Reference

### Profile
```bash
slack.sh profile
```
Shows current authenticated user and team.

### List Channels
```bash
slack.sh channels                              # public + private
slack.sh channels public_channel               # public only
slack.sh channels im                           # DMs only
slack.sh channels public_channel,private_channel,im,mpim  # all types
```
Output: `channel_id  name  type  members:N`

### Read Channel History
```bash
slack.sh history <channel_id> [limit]
```
Default limit: 20. Output: `timestamp | user_id | message_text`

### Read Thread
```bash
slack.sh thread <channel_id> <thread_ts>
```
Output: `timestamp | user_id | message_text`

### Send Message
```bash
slack.sh send <channel_id> "message text"
slack.sh send <channel_id> "reply text" <thread_ts>   # reply in thread

# Preferred for multiline messages/replies. The '-' means read message text from stdin.
slack.sh send <channel_id> - <<'EOF'
First line

Second paragraph
EOF

slack.sh send <channel_id> - <thread_ts> <<'EOF'
Thread reply first line

Thread reply second paragraph
EOF
```
Returns `{ok, channel, ts}` on success.

### Search Messages
```bash
slack.sh search "query string" [count]
```
Default count: 20. Output: `channel_name | timestamp | username | text`

### Users
```bash
slack.sh users                 # list all users
slack.sh users "query"         # search by name/email
```
Output: `user_id  username  real_name  email`

### Edit a Message
```bash
slack.sh edit <channel_id> <message_ts> "new text"

# Preferred for multiline edits. The '-' means read replacement text from stdin.
slack.sh edit <channel_id> <message_ts> - <<'EOF'
First line

Second paragraph
EOF
```
Edits an existing message. Can only edit messages sent by the authenticated user.

### Delete a Message
```bash
slack.sh delete <channel_id> <message_ts>
```
Deletes a message. Can only delete messages sent by the authenticated user.

### React to a Message
```bash
slack.sh react <channel_id> <message_ts> <emoji_name>
```
Adds an emoji reaction. Emoji name can be with or without colons (`:thumbsup:` or `thumbsup`).

### Remove a Reaction
```bash
slack.sh unreact <channel_id> <message_ts> <emoji_name>
```
Removes an emoji reaction. Emoji name can be with or without colons.

### User Info by ID
```bash
slack.sh userinfo <user_id>
```
Looks up a single user by their ID (e.g. `U06CW5QR7LK`). Returns: `user_id  username  real_name  email  title`. Useful for resolving user IDs seen in message history.

### Mark as Read
```bash
slack.sh mark <channel_id>          # mark all as read
slack.sh mark <channel_id> <ts>     # mark up to specific message
```

### User Groups
```bash
slack.sh groups
```
Output: `group_id  @handle  name  users:N`

### Unreads
```bash
slack.sh unreads                                # all channel types
slack.sh unreads im                             # DM unreads only
slack.sh unreads public_channel,private_channel # channel unreads only
```
Shows channels with unread messages and their content.

### Resolve Names
```bash
slack.sh resolve "#general"        # channel name to ID
slack.sh resolve "@username"       # username to DM channel ID
slack.sh resolve "C0123456789"     # passthrough if already an ID
```

## Common Workflows

### Check what's new
```bash
slack.sh unreads
```

### Read a specific channel
```bash
CH=$(slack.sh resolve "#engineering")
slack.sh history "$CH" 30
```

### Reply in a thread
```bash
slack.sh send C0123456789 "Thanks for the update!" 1234567890.123456
```

### Find a user and DM them
```bash
slack.sh users "alice"
DM=$(slack.sh resolve "@alice")
slack.sh send "$DM" "Hey, quick question about the PR"
```

### Search and read context
```bash
slack.sh search "deployment issue"
# Then read the thread for context:
slack.sh thread C0123456789 1234567890.123456
```
