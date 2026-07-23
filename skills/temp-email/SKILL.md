---
name: temp-email
description: Create a temporary email address on @myslop.app and wait for messages to arrive at it. Use for sign-up flows, email verification, magic links, and OTP codes when testing services that require a real receiving inbox.
---

# Temp email

Any address `@myslop.app` is a working inbox — no registration needed. Messages are readable via the authenticated API at `https://mail.myslop.app`, using `$MYSLOP_MAIL_TOKEN`. If it is unset, tell the user instead of guessing. Messages are retained for 7 days, then deleted automatically.

## Create an address

Generate one locally — random enough to avoid collisions and unwanted mail:

```bash
ADDR="tmp-$(openssl rand -hex 4)@myslop.app"
```

Local part rules: lowercase letters, digits, `.`, `_`, `-`; must start alphanumeric; max 64 chars.

## Wait for a message

List the inbox (local part only, no `@domain`). `wait` long-polls up to 50s, returning as soon as a message arrives:

```bash
curl -sS --fail-with-body -H "X-Api-Token: $MYSLOP_MAIL_TOKEN" \
  "https://mail.myslop.app/inbox/<local-part>?wait=50"
```

Response: `{"inbox": "...", "messages": [{"id", "from", "subject", "receivedAt"}]}`. If still empty after a timeout, repeat the call in a loop as needed (e.g. while a sign-up flow completes).

## Read a message

```bash
curl -sS --fail-with-body -H "X-Api-Token: $MYSLOP_MAIL_TOKEN" \
  "https://mail.myslop.app/inbox/<local-part>/<id>"
```

Returns the full message: `from`, `subject`, `text`, `html`, and `links` — a pre-extracted array of all URLs found in the body, which is usually the fastest way to grab a verification/magic link. For OTP codes, grep the `text` field.

## Clean up (optional)

```bash
curl -sS -X DELETE -H "X-Api-Token: $MYSLOP_MAIL_TOKEN" \
  "https://mail.myslop.app/inbox/<local-part>"
```

Not required — the nightly sweep deletes anything older than 7 days.
