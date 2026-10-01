---
name: find-gossip
description: Mine Lleverage meeting transcripts (Gemini notes docs in Google Drive) for fun office gossip and casual chatter — travel mishaps, weekend stories, banter, hobbies, hot takes. Focuses on the start and end of meetings where small talk happens. Use when asked to "find gossip", "any gossip?", "what's the goss", "office chatter", "water cooler talk", or "what fun stuff did people talk about".
metadata:
  author: tvd
  version: 1.0.0
---

# Find Gossip 🕵️

Trawl Gemini meeting transcripts for the good stuff: the casual chat before the meeting starts properly and after it wraps up. This is a fun skill — the output should be light-hearted, kind, and entertaining.

## Account

Always use the Lleverage workspace account:

```bash
export GOG_ACCOUNT=tom@lleverage.ai
```

## Step 1: Find the transcripts

Gemini notes docs are named `<Meeting title> - YYYY/MM/DD HH:MM CEST - Notes by Gemini`. Search Drive:

```bash
gog drive search "Notes by Gemini" --max 25
```

Filtering the results:

- Keep only rows with `TYPE` = `doc` (search also returns unrelated files and `shortcut` rows — shortcuts point at the same doc via `TARGET_ID`, so using only `doc` rows dedupes automatically).
- Use the `MODIFIED` column to scope by date if the user asked for e.g. "this week's gossip". Default scope: the last ~week of meetings, or whatever the user asks for.
- If there are more results, follow the `# Next page: --page <token>` hint printed at the bottom.

## Step 2: Export and slice each transcript

Export each doc to `/tmp/gossip/`:

```bash
mkdir -p /tmp/gossip
gog docs export <docId> --format txt --out /tmp/gossip/<slug>.txt
```

The transcript section starts at a line containing `📖 Transcript` and ends at a line starting with `Transcription ended after`. Utterances are one line each, prefixed `Speaker Name:`, with periodic `HH:MM:SS` timestamp lines. Density is roughly 25–30 lines per minute of meeting.

Slice out the first and last ~5 minutes (≈150 lines each end):

```bash
f=/tmp/gossip/<slug>.txt
start=$(grep -n "📖 Transcript" "$f" | head -1 | cut -d: -f1)
end=$(grep -n "^Transcription ended" "$f" | head -1 | cut -d: -f1)
sed -n "${start},$((start+150))p" "$f"    # opening chatter
sed -n "$((end-150)),${end}p" "$f"        # closing chatter
```

Read both slices. If the opening slice is already deep into agenda talk, the meeting started promptly — move on. If the chatter clearly continues past the slice, read a bit further. Mid-meeting tangents also happen; if a closing slice references an earlier joke or story, it can be worth grepping the full transcript for the keyword.

## Step 3: What counts as gossip

Look for the human stuff, not the work stuff:

- ✅ Travel disasters, delayed trains, missed connections
- ✅ Weekends, holidays, parties, food, weather moaning
- ✅ Hobbies, games, films, hot takes ("Red Dead 2 is better than GTA 5")
- ✅ Banter, teasing, running jokes, who's hosting badly
- ✅ Pets, kids, houses, life events people volunteered cheerfully
- ✅ Playful complaints and dramatic understatement ("I don't want to talk about it")
- ❌ Actual work content, decisions, action items — that's the meeting-notes skill's job

Anything in the transcript is fair game: these are recorded meetings shared with the whole team, so it's public knowledge.

## Step 4: The gossip report

Present findings as a fun digest. Suggested format:

- A cheeky headline per item (e.g. **"Marcus vs the Dutch railway system"**)
- One or two sentences of story, with the meeting name and date
- Short direct quotes where they're funny, attributed with the timestamp
- Group by story, not by meeting; call out running jokes that span multiple meetings

Caveats to keep in mind:

- Transcripts are computer-generated: speakers get misattributed and words get mangled (e.g. "Utre" for Utrecht, "Bjour" for bonjour). Quote loosely and don't pin a dodgy line on someone with certainty.
- Interleaved utterances mean you often need to mentally stitch a story together from fragments across several lines.

## Cleanup

Remove exports when done:

```bash
rm -rf /tmp/gossip
```
