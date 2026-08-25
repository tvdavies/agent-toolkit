# #pull-requests Channel Conventions

Reference for posting and reacting in the `#pull-requests` channel (`C09DWRVAZ33`).

## Posting a PR

Use this format — one line of context, then the PR link. Nothing more.

```
TEAM-123: short description
<GitHub PR URL>
```

Examples from the channel:
- `TEAM-123: fix workflow corruption and add graceful recovery\nhttps://github.com/example/widgets/pull/123`
- `TEAM-456: fix duplicate requests in parallel for-each loops\nhttps://github.com/example/widgets/pull/456`

If the PR is urgent and needs immediate review, prefix with `:rotating_light:` and tag the reviewer:
```
:rotating_light: @reviewer
TEAM-123: short description
<GitHub PR URL>
```

If there's no Linear ticket, use a short descriptive line instead:
```
Remove Run Code Cloud action from agent
<GitHub PR URL>
```

If someone specific is a code owner or should review, tag them on a separate line after the link:
```
TEAM-123: short description
<GitHub PR URL>
@reviewer code owner
```

## PR Review Reactions

Use these emoji reactions on PR messages to signal review status:

| Reaction | Emoji name | Meaning |
|----------|-----------|---------|
| :eyes: | `eyes` | "I'm looking at this" — react when you start reviewing |
| :speech_balloon: | `speech_balloon` | "I've left comments" — react after posting review comments on the PR |
| :white_check_mark: | `white_check_mark` | "Approved" — react when you've approved the PR |

These reactions give the author quick visibility into where their PR is in the review cycle without needing to check GitHub.

## When to Use This Reference

- Posting a new PR to `#pull-requests`
- Reacting to someone else's PR in the channel
- Asking Claude to post or react to PRs on your behalf
