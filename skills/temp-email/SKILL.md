---
name: temp-email
description: Create a temporary email address on @myslop.app and wait for messages to arrive at it. Use for sign-up flows, email verification, magic links, and OTP codes when testing services that require a real receiving inbox. Supports claiming stable, memorable addresses so you can sign back into the same account later.
---

# Temp email

Any address `@myslop.app` is a working inbox — no registration needed. Messages are readable via the authenticated API at `https://mail.myslop.app`, using `$MYSLOP_MAIL_TOKEN`. If it is unset, tell the user instead of guessing. Delivered mail is retained for 7 days, then deleted automatically. Claimed names (see below) are kept indefinitely until released.

All requests need header `-H "X-Api-Token: $MYSLOP_MAIL_TOKEN"`.

## Choosing an address

- **Need to log back into the same account later?** Claim a stable, memorable name (below) and reuse it every time. The account on the target service is keyed to the email, so the same address = the same account.
- **One-off / throwaway?** Just pick any local part, e.g. `tmp-$(openssl rand -hex 4)@myslop.app`. Mail arrives immediately; no claim needed.

## Claim a memorable address

Reserve a name so it is recorded as yours and won't be handed out twice. Omit `name` to get a generated `adjective-noun` name (e.g. `big-donkey`, `argumentative-parrot`):

```bash
# Generated memorable name:
curl -sS --fail-with-body -X POST -H "X-Api-Token: $MYSLOP_MAIL_TOKEN" \
  -H "Content-Type: application/json" -d '{"note":"staging llev.dev"}' \
  https://mail.myslop.app/claim

# Or request a specific one (201 if granted, 409 if already in use):
curl -sS --fail-with-body -X POST -H "X-Api-Token: $MYSLOP_MAIL_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"big-donkey","note":"staging llev.dev"}' \
  https://mail.myslop.app/claim
```

Response includes `address` (e.g. `big-donkey@myslop.app`) — use that in the sign-up form. Record which name maps to which service (the `note` field is for this).

- List your claims: `GET https://mail.myslop.app/claims`
- Release one: `DELETE https://mail.myslop.app/claim/<name>`

Claiming is a naming registry only — it does not gate mail delivery (every address receives regardless). Its purpose is memorable names and avoiding collisions.

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

Returns the full message: `from`, `subject`, `text`, `html`, and `links` — a pre-extracted array of all URLs found in the body, usually the fastest way to grab a verification/magic link. For OTP codes, grep the `text` field.

## Clean up (optional)

```bash
# Purge stored messages for an inbox (keeps any claim):
curl -sS -X DELETE -H "X-Api-Token: $MYSLOP_MAIL_TOKEN" \
  "https://mail.myslop.app/inbox/<local-part>"
```

Not required — the nightly sweep deletes mail older than 7 days. Note some providers screen disposable domains; `@myslop.app` works only where the domain is allowed/allowlisted.
