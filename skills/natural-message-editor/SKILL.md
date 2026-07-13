---
name: natural-message-editor
description: Drafts and revises concise, conversational messages intended for people across Slack, Linear, GitHub, email, and similar channels. Use when writing, rewriting, polishing, or shortening comments, replies, updates, review feedback, and other human-facing messages. Avoids em dashes and fussy punctuation, limits unnecessary lists, removes overly formal or verbose language, and preserves the writer's meaning and voice.
metadata:
  author: tvd
  version: 1.0.0
---

# Natural Message Editor

## Important

Apply this style whenever drafting prose that the user is likely to send directly to another person. This includes Slack messages, Linear comments, GitHub comments, review feedback, emails, announcements, and status updates.

Do not apply it to code, logs, commit patches, structured data, technical documentation, or other content where exact syntax or an established format matters. Preserve quoted text exactly unless the user asks to edit it.

## Instructions

### Write for a person

Make the message sound like a thoughtful person wrote it, not a report or template.

- Use natural phrasing and contractions where appropriate.
- Be direct without sounding abrupt.
- Keep the writer's meaning, intent, confidence, and emotional tone.
- Prefer familiar words over formal or corporate language.
- Remove throat-clearing, repetition, filler, and unnecessary summaries.
- Do not add fake warmth, exaggerated enthusiasm, or generic pleasantries.

### Keep punctuation simple

- Do not use em dashes.
- Avoid semicolons. Split the sentence or use a conjunction instead.
- Use colons sparingly and only when they genuinely improve clarity.
- Avoid excessive parentheses, slashes, ellipses, and other fussy punctuation.
- Prefer short, clean sentences, but vary their rhythm so the message does not sound mechanical.

### Use structure only when it helps

Do not automatically turn ideas into a list. Use a short paragraph when the message reads naturally as one.

Use bullets when the recipient needs to scan several distinct items, action points, findings, or questions. Keep bullets parallel and concise. Avoid headings for short messages unless the channel or subject benefits from them.

### Respect the destination

Match the conventions and context of the channel.

- Slack should usually be brief, informal, and easy to reply to.
- Linear comments should give enough context to support the decision or next step.
- GitHub comments and review feedback should be precise, constructive, and technically complete.
- Email can be slightly more structured, but should still sound conversational.

Preserve mentions, links, issue identifiers, code spans, code blocks, and required templates. Never trade away important technical detail merely to make a message shorter.

### Return the usable message

When the user asks for a draft or rewrite, return the message itself without explaining the edits. Do not introduce it with phrases such as "Here is a polished version" unless the user asks for commentary or alternatives.

If tone, audience, or intent is genuinely unclear and would materially change the message, ask one focused question. Otherwise, make a reasonable choice and draft the message.

## Final Check

Before returning the message, confirm that it:

- Has no em dashes
- Uses simple punctuation
- Sounds conversational when read aloud
- Is no longer than needed
- Uses a list only when a list improves comprehension
- Preserves all important meaning, facts, requests, and technical details
- Fits the destination and relationship between the writer and recipient

## Examples

### Slack update

User says: "Write a Slack message telling the team that the deploy is delayed because CI is flaky, but we're investigating and should know more in an hour."

Result:

"The deploy is delayed because CI is flaky. We're looking into it now and should have a clearer update within the next hour."

### GitHub review comment

User says: "Rewrite this review comment: This introduces a race condition; specifically, the callback may execute after teardown, which means that state can be updated after the component has unmounted."

Result:

"This can introduce a race condition because the callback may run after teardown and update state after the component has unmounted. Could we cancel the callback during cleanup?"

### Linear comment with several actions

User says: "Draft a Linear comment with three follow-ups for the API migration."

Result:

"The migration path looks good. Before we start, we still need to:

- Confirm the cutoff date with the integrations team
- Add metrics for requests using the old endpoint
- Document the rollback steps"

## Common Issues

### The message sounds too formal

Replace report-like phrasing with direct, everyday language. Remove unnecessary context-setting and keep only what helps the recipient understand or act.

### The message is too terse

Restore any context needed to avoid confusion or unintended bluntness. Concise does not mean stripped of rationale, empathy, or a clear request.

### A list feels unnatural

Turn it into one or two short paragraphs unless the recipient must scan distinct items or actions.

### Simplification removed technical meaning

Restore the exact constraint, risk, identifier, or requested action. Clarity and correctness take priority over brevity.
