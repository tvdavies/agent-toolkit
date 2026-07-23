---
name: create-myslop-app
description: Scaffold, deploy, and register a new microfrontend app in the myslop OS (a Module Federation platform on Cloudflare). Use when building a new tool/app that should run standalone at its own <id>.myslop.app URL and also embed as a microfrontend inside the shell at os.myslop.app.
---

# Create a myslop app

The myslop OS is a Module Federation platform. The shell (`os.myslop.app`) loads apps at runtime from their own deployments; each app also runs standalone at `<id>.myslop.app`. Project root: `~/dev/tvdavies/myslop-os`. Deploys use `$CLOUDFLARE_API_TOKEN` (in `~/.config/fish/conf.d/cloudflare.fish`).

Apps are built from shared building blocks so everything looks and behaves consistently:

- **`@myslop/ui`** — shared shadcn/Tailwind components (`Button`, `Card`, `cn`, …) and design tokens. Use these instead of hand-rolled styles.
- **`@myslop/sdk`** — the kernel. `createApp(Component)` wraps a plain component into an app that works embedded or standalone. Inside, use hooks: `useHost()`, `useTheme()`, `useNotify()`.
- **Theming is automatic** — the shell toggles `.dark` on `<html>`; components styled with the shared tokens (`bg-background`, `bg-card`, `text-muted-foreground`, …) restyle for free. Don't hard-code colors.

## 1. Scaffold

```bash
cd ~/dev/tvdavies/myslop-os
bun scripts/create-app.ts <id> "Display Name"   # id: lowercase, e.g. "notes"
bun install                                      # link the new workspace
```

This creates `apps/<id>/` preconfigured with Tailwind, the shared UI, a `createApp`-wrapped component, a standalone entry, a `wrangler.jsonc` targeting `<id>.myslop.app`, and a `_headers` file with the CORS the shell needs.

## 2. Build the app

Edit `apps/<id>/src/App.tsx`. Pattern:

```tsx
import { createApp, useHost, useTheme } from "@myslop/sdk";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@myslop/ui";

function MyApp() {
  const host = useHost();          // kernel: host.theme, host.ping, host.notify
  return <Card>…<Button onClick={() => host.notify("hi")}>Go</Button>…</Card>;
}
export default createApp(MyApp);
```

Style with Tailwind classes + the shared tokens. Add new shared components to `packages/ui` so every app can use them.

## 3. Deploy the app

```bash
cd apps/<id> && bun run deploy
```

Builds with `PUBLIC_ORIGIN=https://<id>.myslop.app` (required — a build without it points federation chunks at localhost) and runs `wrangler deploy`. Verify: `curl -s https://<id>.myslop.app/mf-manifest.json | grep publicPath` shows the app's own origin.

## 4. Register in the shell

Edit `host/`:

- `host/rsbuild.config.ts` — add to `remotes`: `"<id>": "<id>@https://<id>.myslop.app/mf-manifest.json"`
- `host/src/remotes.d.ts` — declare `module "<id>/App"`
- `host/src/App.tsx` — `const XApp = lazy(() => import("<id>/App"))` and render `<XApp host={host} />`

Then redeploy the host: `cd host && HELLO_ORIGIN=https://hello.myslop.app bun run build && bunx wrangler deploy`.

## Identity / auth

The OS requires sign-in (shoo, `github.com/pingdotgg/shoo` — Google only for now). The shell authenticates the user and gets a shoo `id_token` (ES256 JWT); apps read the user via `useUser()`:

```tsx
import { useUser } from "@myslop/sdk";
const user = useUser(); // { id, email?, name?, picture? } | null
```

Enforcement: `events.myslop.app/token` verifies the shoo id_token (against shoo's JWKS) before minting any scoped token, and embeds the user id. So **no data access (events/storage/files) without a signed-in user** — the per-app scoping is now user-gated, not just structural. Apps never handle the id_token; the shell does, and injects pre-scoped service handles.

## The mini cloud (available host services)

The kernel (`useHost()`) provides `theme`, `ping`, `notify`, `events`, `storage`, `files`, and `user`. Check `@myslop/sdk` for what's live before assuming.

### Events (live) — `useEvents()`

Cross-app pub/sub over a Durable Object hub (`events.myslop.app`), scoped per app:

```tsx
import { useEvents } from "@myslop/sdk";

const events = useEvents();
// Private to this app (channel app:<id>:*), isolated from other apps:
const off = events.subscribe("counter", (data) => { /* ... */ });
events.publish("counter", { n: 1 });
// Shared across apps (channel shared:*):
events.shared.subscribe("announcements", (data) => { /* ... */ });
events.shared.publish("announcements", { from: "myapp", text: "hi" });
```

Scoping is server-enforced: an app can only reach its own `app:<id>:*` channels plus `shared:*`. The shell mints a per-app scoped token (signed server-side; the secret never reaches the browser) and injects the handle. **Trust caveat**: under Module Federation the app id isn't cryptographically proven, so scoping is a structural boundary, not a hard security one — it hardens when the shell gains a per-user session (the identity slice).

### Storage (live) — `useStorage()`

Durable per-app key/value storage (Workers KV via `storage.myslop.app`), isolated per app:

```tsx
import { useStorage } from "@myslop/sdk";

const storage = useStorage();
await storage.set("counter", { count: 1 }); // JSON values
const v = await storage.get<{ count: number }>("counter"); // null if absent
const keys = await storage.list("prefix");  // app-relative key names
await storage.delete("counter");
```

Keys are app-relative; the service namespaces them as `app:<id>:<key>` and an app can only read/write its own. Uses the **same** scoped token as events (one identity per app across services; the shell injects it). Same structural-not-cryptographic trust caveat as events.

### Files (live) — `useFiles()`

Upload a blob and get a durable, public URL (for PRs, Slack, sharing HTML):

```tsx
import { useFiles } from "@myslop/sdk";

const files = useFiles();
const url = await files.upload("<h1>hi</h1>", "snapshot.html", { contentType: "text/html" });
// -> https://files.myslop.app/app/<id>/<random>/snapshot.html
```

Uploads go through a scoped-upload endpoint on `files.myslop.app` that verifies the app's scoped token (same token as events/storage) and stores under `app/<id>/…` — the R2 upload secret never reaches the browser. Unlike storage, files are **public-by-URL** (that's the point — shareable links); the per-app namespace + random prefix prevent collisions and enumeration, not read access.

### Planned

- **database** (`useDb`) — per-app D1 query access.

## Gotchas (baked into the scaffold, but know them)

- **Async boundary**: entries must be `import("./bootstrap")`, never mount React directly (else MF `loadShareSync` / RUNTIME-006).
- **assetPrefix**: always deploy with `PUBLIC_ORIGIN` set, or the manifest bakes in `localhost`.
- **Static assets** need `not_found_handling: "single-page-application"` in wrangler or the root 500s (error 1104).
- **Browser cache**: after redeploying in dev, hashed chunk URLs can hold a stale cached error (RUNTIME-008). A fresh visitor is unaffected; hard-reload / clear cache to re-test.
- **Isolation**: MF runs app code in the host's origin. Don't put secrets in the shell that an app shouldn't reach until there's an isolation story.
