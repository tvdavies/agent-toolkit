---
name: create-myslop-app
description: Scaffold, deploy, and register a new microfrontend app in the myslop OS (a Module Federation platform on Cloudflare). Use when building a new tool/app that should run standalone at its own <id>.myslop.app URL and also embed as a microfrontend inside the shell at os.myslop.app.
---

# Create a myslop app

The myslop OS is a Module Federation platform. The shell (`os.myslop.app`) loads apps at runtime from their own deployments; each app also runs standalone at `<id>.myslop.app`. Project root: `~/dev/tvdavies/myslop-os`. Deploys use `$CLOUDFLARE_API_TOKEN` (in `~/.config/fish/conf.d/cloudflare.fish`).

## 1. Scaffold

```bash
cd ~/dev/tvdavies/myslop-os
bun scripts/create-app.ts <id> "Display Name"   # id: lowercase, e.g. "notes"
bun install                                      # link the new workspace
```

This creates `apps/<id>/` — a federated remote (exposes `./App`) that also has a standalone entry, a `wrangler.jsonc` targeting `<id>.myslop.app`, and a `_headers` file with the CORS the shell needs.

## 2. Build the app

Edit `apps/<id>/src/App.tsx`. The component receives `{ host }: AppProps` from `@myslop/sdk`. Call `resolveHost(host)` to get the kernel API (works embedded or standalone). Available host services: `host.theme`, `host.ping(msg)`, `host.notify(msg)`. Keep it a single default-exported React component.

## 3. Deploy the app

```bash
cd apps/<id> && bun run deploy
```

This builds with `PUBLIC_ORIGIN=https://<id>.myslop.app` (so federation chunks resolve to the app's own origin — this is required, a build without it points chunks at localhost) and runs `wrangler deploy`. Verify: `curl -s https://<id>.myslop.app/mf-manifest.json | grep publicPath` should show the app's own origin.

## 4. Register in the shell

To make the app appear inside the OS, edit `host/`:

- `host/rsbuild.config.ts` — add to `remotes`: `"<id>": "<id>@https://<id>.myslop.app/mf-manifest.json"`
- `host/src/remotes.d.ts` — declare `module "<id>/App"`
- `host/src/App.tsx` — `const XApp = lazy(() => import("<id>/App"))` and render `<XApp host={host} />` in a window

Then redeploy the host:

```bash
cd host && HELLO_ORIGIN=https://hello.myslop.app <id>_ORIGIN=... bun run build && wrangler deploy
```

(The host build reads each remote's origin from its rsbuild config; keep the remote origins in sync.)

## Gotchas (learned the hard way)

- **Async boundary**: entries must be `import("./bootstrap")`, never mount React directly, or Module Federation throws `loadShareSync` / RUNTIME-006.
- **assetPrefix**: always deploy with `PUBLIC_ORIGIN` set, or the manifest bakes in `localhost` and the shell can't load the app cross-origin.
- **Static assets need `not_found_handling: "single-page-application"`** in wrangler, or the root path returns a Cloudflare 500 (error 1104).
- **Browser cache**: after re-deploying during development, hashed chunk URLs can hold a stale cached error. A fresh visitor is unaffected; hard-reload to re-test.
- **Isolation**: MF runs app code in the host's origin. Do not put secrets/tokens in the shell that an app shouldn't reach until there's an isolation story.
