---
name: lleverage-prod-access
description: Log into the production Lleverage app (https://app.lleverage.ai) as the shared "Claude" account to capture screenshots and video clips of the shared change-log project. Use when asked to produce change-log docs, screenshots, or demo clips from the production app.
---

# Lleverage production access (change-log account)

A shared production account exists for building change-log material from shared
sample data. The account is keyed to a permanently claimed temp-email inbox, so
the same account works across sessions.

## Account

- **Email:** `misty-jellyfish@myslop.app` (claimed permanently via the
  `temp-email` skill — do not release this claim)
- **Name in app:** Claude (member of org **Lleverage AI**)
- **Org URL slug:** `lqnc85`
- **Shared project:** "Grandson of Anton" — `https://app.lleverage.ai/lqnc85/projects/1qibvknj/agent`

There is no password. Authentication is a magic one-time code emailed on every
sign-in.

## Login flow (Playwright)

1. Read the mail token as in the `temp-email` skill:
   `TOKEN="${MYSLOP_MAIL_TOKEN:-$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/myslop-mail/token")}"`
2. Navigate to `https://app.lleverage.ai` (redirects to `signin.lleverage.ai`
   if not already authenticated — an existing browser profile session may still
   be valid, so check first).
3. Fill the **Email** field with `misty-jellyfish@myslop.app` and click
   **Continue with email**.
4. The page moves to a 6-digit magic-code form. Fetch the code:

   ```sh
   curl -sS --fail-with-body -H "Authorization: Bearer $TOKEN" \
     "https://mail.myslop.app/inbox/misty-jellyfish?wait=50"
   # then read the newest message (subject "Sign in to Lleverage" or
   # "Sign up for Lleverage") and grep the 6-digit code from its text field
   ```

   Prefer opening the SSE stream *before* clicking "Continue with email" so the
   code is pushed instantly.
5. Type the 6 digits into the first OTP input with `slowly: true` (the inputs
   auto-advance and auto-submit).
6. On success you land in the app. Codes expire in 10 minutes.

## Capture conventions (screenshots / clips)

- Resize the browser to a consistent viewport before capturing:
  1440×900 for screenshots.
- Use `browser_take_screenshot` with descriptive filenames, e.g.
  `changelog-<feature-slug>-<step>.png`.
- For short clips, drive the UI step-by-step and capture screenshots per step;
  assemble with ffmpeg if a video is required
  (`ffmpeg -framerate 1 -i step-%d.png ...`), or record with Playwright video
  if available.
- Work only inside the shared project unless told otherwise; it exists so that
  sample data in captures is safe to publish internally.

## Sample data in the shared project

Built 2026-08-07 for the linked-subworkflows + retry change-log; reuse rather
than recreate:

- **Format Order Summary** (`wrk-5da1ef16-6841-46d5-8192-27c2b3a2f42d`) —
  simple API-triggered LLM workflow (order details → friendly confirmation).
  Published v1.0 and v1.1. Used as a *linked subworkflow*.
- **Process New Order** (`wrk-d3185cde-bfef-4ec9-bf8e-e796595227ab`) — parent
  workflow embedding Format Order Summary as a linked subworkflow node.
  Published v1.0.
- **Sync Order to ERP** (`wrk-0e1f504c-d215-4e77-994d-7d8f34c3e936`) — retry
  demo. The "Sync To ERP" code node **fails on even minutes** (throws "ERP
  connection timed out") and succeeds on odd minutes — time runs/retries
  accordingly. Endpoint: `https://lqnc85.lleverage.ai/mahgmaz1` (POST JSON
  `{"Order_id": "1042"}`; GET/query params do not reach `.body`).
- **Dispatch Delivery** (`wrk-9cfa2603-392a-405c-805c-ab8db88a35bb`) —
  operator/app-trigger retry demo. Published v1.0 with an **App trigger** and a
  Delivery ID form; the "Notify Carrier" code node fails on even minutes
  ("Carrier API unavailable"). Operator flow: project home → the
  "App: Dispatch Delivery" card (or `/apps/wrk-9cfa…`) → submit the form →
  session lives at `/app-sessions/<sessionId>`, where a failed run shows
  **Retry from the failed step**.
- **Approve Invoice Payment** (`wrk-42d68a7a-17f8-47d2-964f-3030fb83d9f1`) —
  stranded-request/retry-recovery demo, published v1.1. App trigger + invoice
  id form → "Register Invoice" code node → PARALLEL branches: "Manager
  Approval" request node (assigned to Claude, Approve/Reject options) and
  "File Confirmation" code node (fails even minutes). Both join into the
  return. Fail run (even minute) ⇒ pending approval gets stranded ("This
  workflow run failed, so this request can't be submitted"); retry (odd
  minute) re-issues the approval live in the same session. Approval request
  nodes require assignees or they show "Missing Details".
- Run panel forms and the Copilot can drive everything; subworkflow node input
  mapping is manual (type `{{` in the input field for variable autocomplete —
  references look like `{{Process_New_Order.body.Order_items}}`). Copilot
  cannot map subworkflow inputs or add edges reliably — drag edges between
  node handles with mouse down/move/up on `.react-flow__handle` elements.
- Time-based flaky nodes: fail window = even minutes, success = odd minutes.
  Sleep until the right window before submitting or retrying.

## Publishing captures and docs

Share screenshots and docs via the `file-upload` skill (files.myslop.app).
Write change-log docs as self-contained HTML pages that embed the uploaded
screenshot URLs (upload images first, then reference the returned URLs in
`<img>` tags), and upload the HTML too — it is served as a browsable page.
Prefix filenames with `lleverage-changelog-` for the dashboard.

## Notes

- Invites/notification mail from the app arrives at the same inbox; the
  `temp-email` skill documents reading and streaming it.
- The account is a plain **member** — org administration is done by Tom.
