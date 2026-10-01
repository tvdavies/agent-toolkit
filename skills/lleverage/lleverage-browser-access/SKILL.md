---
name: lleverage-browser-access
description: Drive a browser against local (localhost:3000), staging (app.staging.llev.dev) or production (app.lleverage.ai) Lleverage for testing and debugging, including signing in. Use when asked to open, test, QA, screenshot or debug the Lleverage app in any environment.
---

# Lleverage browser access

Browser: the `lleverage-browser` MCP server (Playwright MCP, headless system
Chromium). Registered in Codex and Claude Code. Launcher:
`~/.local/bin/lleverage-browser-mcp` (`LLEVERAGE_BROWSER_HEADED=1` for a window).
Persistent profile `~/.local/share/lleverage-browser/profile` keeps cookies for
all three environments; output files go to `~/.local/share/lleverage-browser/output`.
Always navigate first: an existing session is usually still valid.

## Accounts

| Env | URL | Account | Landing |
| --- | --- | --- | --- |
| Production | https://app.lleverage.ai | misty-jellyfish@myslop.app (member of org Lleverage AI) | /lqnc85/projects/1qibvknj/agent |
| Staging | https://app.staging.llev.dev | misty-jellyfish@myslop.app (owner of org "Claude QA") | /awwojdh99/projects/d4078oxv/agent |
| Local | http://localhost:3000 | DEV_AUTO_LOGIN_EMAIL (see below) | - |

Production rules for the shared account live in the `lleverage-prod-access`
skill: stay inside the shared project unless told otherwise.

## Magic-code sign-in (staging and production)

1. Navigate to the app; it redirects to the AuthKit sign-in page.
2. Note the time: `date -u +%Y-%m-%dT%H:%M:%SZ`.
3. Type the email into the Email box and submit.
4. Get the code: `myslop-otp misty-jellyfish <time-from-step-2>` (waits up to
   120 s; uses the myslop mail token, see `temp-email` skill).
5. Type the code with `slowly: true` into `[data-test="otp-input"]`; it
   auto-submits. Wait a few seconds for the redirect.

## Local

Local uses the STAGING WorkOS client, while the local database is a nightly
copy of production. `DEV_AUTO_LOGIN_EMAIL` in the root `.env` of
`~/dev/lleverage-ai/lleverage` signs a browser in automatically, but only for a
local user row whose `authProviderId` is a staging WorkOS user with the same
email. Otherwise use the magic-code flow above against localhost.
Start the app with `pnpm dev --filter app` (see `local-dev-services`).
