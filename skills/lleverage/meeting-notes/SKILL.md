---
name: meeting-notes
description: Pull Gemini meeting notes and transcripts for Lleverage meetings from Google Drive/Docs. Use when asked to get, pull, read, or summarise meeting notes, a meeting transcript, standup notes, initiative check-in notes, or "what was discussed in <meeting>". Knows the right Google account and the gog commands to find and export the notes doc.
metadata:
  author: tvd
  version: 1.0.0
---

# Meeting Notes

Retrieve Gemini-generated meeting notes and transcripts from Google Drive using the `gog` CLI (see the `gog` skill for general usage).

## Account

Always use the Lleverage workspace account:

```bash
export GOG_ACCOUNT=tom@lleverage.ai
```

Without this, `gog` fails with `missing --account`. Do not use `tvdavies@gmail.com` or `tom@erys.ai` for work meetings.

## Finding the notes doc

Gemini notes docs are named like:

```
<Meeting title> - YYYY/MM/DD HH:MM CEST - Notes by Gemini
```

Examples: `Initiative Check-in: Agents in Workflows - 2026/08/28 10:39 CEST - Notes by Gemini`, `Daily Standup - 2026/08/28 09:59 CEST - Notes by Gemini`.

Search Drive by meeting name keywords (results are shared docs owned by whoever hosted, e.g. `joost@lleverage.ai` or `alex@lleverage.ai` — ownership does not matter):

```bash
gog drive search "initiative check-in" --max 10
gog drive search "daily standup" --max 10
```

Pick the row with `TYPE` = `doc` and a name ending in `Notes by Gemini`, matching the requested date/time (the `MODIFIED` column helps disambiguate "this morning" vs older). If the meeting title is unknown, search for `"Notes by Gemini"` and filter by date.

## Exporting the notes

Export as text (preferred — keeps a local copy to read/quote from):

```bash
gog docs export <docId> --format txt --out /tmp/<slug>-notes.txt
```

Or print straight to stdout:

```bash
gog docs cat <docId>
```

## Document structure

Gemini notes docs contain, in order:

1. **✍️ Quick notes** — short summary, bullet-point topic sections, and a `Next steps` action-item list (`[Person] {Action}: description`).
2. **📝 Full notes** — longer summary, a `Decisions` section (split into `Aligned` and `Needs Further Discussion`), the same `Next steps`, and a detailed `Details` section with timestamps.
3. **📖 Transcript** — full computer-generated transcript with per-minute timestamps. Can contain transcription errors and misattributed speakers.

When the user asks for "the notes", give them the quick notes/summary, decisions, and next steps. Only dig into the transcript when they ask for detail, exact quotes, or something not covered by the summaries. Ignore the interleaved Gemini boilerplate ("Want to see more?", survey prompts, "You should review Gemini's notes…").
