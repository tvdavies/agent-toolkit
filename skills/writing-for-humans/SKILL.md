---
name: writing-for-humans
description: Human-facing messages. Use whenever drafting, revising, or about to post a GitHub PR comment/review/reply, Linear ticket comment/update, Slack message, or email. Covers implementation summaries, triage conclusions, closure notes, and re-review requests. Produces concise, conversational, send-ready prose while preserving necessary technical facts, IDs, mentions, links, and code.
metadata:
  author: tvd
  version: 1.3.0
---

# Writing for Humans

Produce a **send-ready** message that sounds like a thoughtful person speaking to a colleague. Preserve the writer's meaning, confidence, and technical accuracy while making the outcome and next action easy to find.

Apply this skill proactively before posting human-facing prose. Code, logs, structured data, technical documentation, and required templates keep their established format.

This skill covers message structure, evidence curation, and channel fit. For line-level style (AI-pattern tells, punctuation, plain word choice, active voice), apply the `unslop` skill; those rules are not repeated here.

## Process

### 1. Find the point

Identify:

- What happened or what the writer needs
- Which context the recipient needs to understand it
- What happens next

The point is clear when the recipient can understand the outcome from the opening and the action from the ending.

### 2. Curate the evidence

Keep a detail when it changes the recipient's understanding, confidence, or next action. Summarize supporting evidence that does not need to be audited in the comment.

For example, prefer "All tests and type checks pass" over exact test counts unless the counts are relevant to the discussion. Keep identifiers, dates, commit hashes, and related tickets when they help the recipient verify the result or follow the work.

### 3. Write the human update

Lead with the outcome. Write as "I" speaking to a colleague, and edit the prose with the `unslop` skill.

For a substantial update, use short paragraphs in this order:

1. Outcome
2. Necessary explanation or evidence
3. Next action

Use bullets only when the recipient needs to scan distinct findings, actions, or questions.

### 4. Make it send-ready

Before returning or posting the message, confirm that:

- The outcome and next action are immediately clear
- Every included detail helps the recipient understand or act
- The prose has been through an `unslop` pass
- Mentions, links, issue IDs, code spans, and important technical constraints remain intact
- The message fits the destination and relationship

The edit is complete only when every check passes.

## Channel Fit

### GitHub

Be precise and constructive. Explain what changed and whether anything remains. Put requests such as re-review at the end where they are easy to act on.

### Linear

Give enough context to support the decision or status change. State why the issue is being closed, reopened, reassigned, or left open. Separate related work from the issue being discussed.

### Slack

Be brief, informal, and easy to reply to. Keep investigation history out unless it helps the conversation move forward.

### Email

Use slightly more structure when the recipient needs context, while keeping the language conversational.

## Natural Translations

Translate report language into language a colleague would use:

- "Addressed the follow-up review" → "I addressed the follow-up"
- "Root cause was established" → "It turned out to be"
- "Validation passed" → "All tests and checks pass"
- "No recurrence has been observed" → "We haven't seen it happen again"
- "Closing as resolved" → "Closing this because the issue is resolved"

Prefer contractions where they sound natural.

## Examples

### GitHub follow-up

Dense status report:

> Addressed the follow-up review in e47f2ad7d3: restored partial path-version and exact `slug@version` compatibility, preserved active-version semantics, mapped network/JSON failures to retryable results, blocked credential-bearing untrusted HTTP, and added env/security/retry/compatibility coverage. Validation passed: 349 workflow-service tests, 6,857 app tests (9 skipped), both type checks, and `git diff --check`. @jaythegeek ready for re-review.

Send-ready comment:

> I addressed the follow-up in e47f2ad7d3. This restores partial path-version and exact `slug@version` support without changing active-version behaviour. Network and JSON failures are now retryable, and credentials won't be sent over untrusted HTTP.
>
> I added coverage for the compatibility, retry, environment, and security cases. All tests and type checks pass.
>
> @jaythegeek, this is ready for another look.

### Linear resolution

Dense status report:

> Triage 2026-08-05: root cause was established in-thread on Jul 31 — the Outlook token refresh POST to login.microsoftonline.com hit a transport-level 'fetch failed' (network blip), not a revoked credential; the same credential refreshed fine from 08:44 onwards. Noah added continue:retry to the node the same day so this self-heals. No recurrence of 'Token refresh failed' since Jul 31. The still-live Armada problem is different (LLE-11949, Fetch_Invoice AccountView 400, with Alex Jay; retry-branch error-handling follow-up is FDE-3635). Closing as resolved.

Send-ready comment:

> Closing this as resolved. The Outlook refresh failure on 31 July was a temporary network error, not a revoked credential. The credential refreshed successfully afterwards, and Noah added `continue:retry` so the node now recovers automatically. We haven't seen the error recur.
>
> The remaining Armada issue is separate and tracked in LLE-11949. FDE-3635 covers the follow-up work on retry-branch error handling.

## Output and Posting

When asked for a draft or rewrite, return the usable message without an explanation or preamble unless the user asks for commentary or alternatives.

When another skill or tool will post the message, complete the send-ready check before the posting action. Post the edited message rather than raw investigation notes, tool output, or a compressed work log.
