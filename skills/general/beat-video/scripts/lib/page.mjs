// Open a video folder's index.html in record mode at its format, and collect page errors.
import { existsSync } from "node:fs";
import path from "node:path";
import { browser, format } from "./deps.mjs";

export async function openVideo(dir, { b, errors = [] } = {}) {
  const html = path.resolve(dir, "index.html");
  if (!existsSync(html)) throw new Error(`${html} not found`);
  const { w, h } = format(dir);
  const br = b || await browser();
  const page = await br.newPage({ viewport: { width: w, height: h } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("requestfailed", (r) => { if (!r.url().endsWith(".mp3")) errors.push(`failed to load ${r.url()}`); });
  await page.goto(`file://${html}?record&w=${w}&h=${h}`);
  await page.waitForFunction(() => window.READY === true, null, { timeout: 20000 });
  return { browser: br, page, w, h, errors };
}
