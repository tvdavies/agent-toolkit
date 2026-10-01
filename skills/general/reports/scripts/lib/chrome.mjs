// Minimal headless Chrome/Chromium driver over the DevTools protocol. No dependencies.
// Requires Node 22+ (global WebSocket) and a Chrome/Chromium binary ($CHROME or on PATH).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export class ChromeUnavailable extends Error {}

export function findChrome() {
  const candidates = [process.env.CHROME, "chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean);
  for (const c of candidates) {
    if (c.includes("/")) { if (fs.existsSync(c)) return c; continue; }
    const r = spawnSync("which", [c], { encoding: "utf8" });
    if (r.status === 0) return r.stdout.trim();
  }
  return null;
}

// Starts Chrome and returns { newPage, close }. Always call close() (use try/finally).
export async function launchChrome() {
  if (typeof WebSocket === "undefined") throw new ChromeUnavailable("Node 22+ is required (global WebSocket).");
  const chrome = findChrome();
  if (!chrome) throw new ChromeUnavailable("No Chrome/Chromium found. Set $CHROME to a Chrome or Chromium binary.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "report-chrome-"));
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const cleanup = () => { try { proc.kill(); } catch {} fs.rmSync(profile, { recursive: true, force: true }); };

  let ws;
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("Chrome did not start within 20s")), 20000);
      proc.stderr.on("data", (d) => {
        buf += d;
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      proc.on("exit", (code) => reject(new Error(`Chrome exited (${code})`)));
    });
    ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  } catch (error) {
    cleanup();
    throw error;
  }

  let nextId = 1;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const w of [...waiters]) if (w.method === msg.method && (!w.sessionId || w.sessionId === msg.sessionId)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const waitFor = (method, sessionId) => new Promise((resolve) => waiters.push({ method, sessionId, resolve }));

  async function newPage() {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    await s("Page.enable");
    await s("Runtime.enable");
    return {
      setViewport: (width, height, { mobile = false, scale = 1 } = {}) => s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile }),
      clearViewport: () => s("Emulation.clearDeviceMetricsOverride"),
      async goto(url) {
        const loaded = waitFor("Page.loadEventFired", sessionId);
        await s("Page.navigate", { url });
        await loaded;
        await s("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true });
      },
      async evaluate(expression) {
        const { result, exceptionDetails } = await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result.value;
      },
      async screenshot(clip) {
        const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, ...(clip ? { clip: { scale: 1, ...clip } } : {}) });
        return Buffer.from(data, "base64");
      },
      async pdf() {
        const { data } = await s("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
        return Buffer.from(data, "base64");
      },
    };
  }

  return {
    newPage,
    close() {
      try { ws.close(); } catch {}
      cleanup();
    },
  };
}
