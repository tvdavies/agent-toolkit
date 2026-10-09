#!/usr/bin/env node
// Is a feature flagged, and what does production set? Searches the three places Lleverage gates features:
//   1. app feature flags (apps/app/src/lib/feature-flags/constants.ts and isOn(...) call sites)
//   2. service environment schemas (apps/*/src/env.ts, packages/*/src/env.ts): defaults
//   3. infrastructure overlays (production and staging): what each deployment actually sets
//   node flags.mjs <term> [<term> ...]        e.g. node flags.mjs steering STEER
// A feature is shown as live only if its flag is on in production for everyone (or it has no flag).
import { execFileSync } from "node:child_process";
import { appRepo, infraRepo } from "./lib/repo.mjs";

const terms = process.argv.slice(2);
if (!terms.length) { console.error("usage: flags.mjs <term> [<term> ...]"); process.exit(1); }
// Search the fetched origin/main tree, not the working tree: a local checkout is often behind.
const grep = (repo, paths, ref = "origin/main") => {
  try { return execFileSync("git", ["-C", repo, "grep", "-n", "-i", "-I", ...terms.flatMap((t) => ["-e", t]), ref, "--", ...paths], { encoding: "utf8", maxBuffer: 1 << 26 }).trim().split("\n").filter(Boolean).map((l) => l.replace(ref + ":", "")); }
  catch { return []; }
};
const app = appRepo(), infra = infraRepo();
try { execFileSync("git", ["-C", app, "fetch", "--quiet", "origin", "main"], { stdio: "ignore" }); } catch { console.warn("git fetch failed; searching the local origin/main"); }
const show = (title, lines, max = 25) => { console.log(`\n## ${title}${lines.length ? "" : ": nothing found"}`); for (const l of lines.slice(0, max)) console.log("  " + l.slice(0, 220)); if (lines.length > max) console.log(`  … ${lines.length - max} more`); };
show("App feature flags", grep(app, ["apps/app/src/lib/feature-flags/"]));
show("isOn(...) call sites", grep(app, ["apps/app/src"]).filter((l) => /isOn\(|useFeatureFlag|featureFlag/i.test(l)));
show("Service env defaults", grep(app, ["apps/*/src/env.ts", "packages/*/src/env.ts", "apps/*/src/env/*.ts"]));
if (infra) {
  try { execFileSync("git", ["-C", infra, "fetch", "--quiet", "origin"], { stdio: "ignore" }); } catch {}
  show("Production overlays (infrastructure origin/main)", grep(infra, ["*overlays*/*production*/*"], "origin/main"));
  show("Staging overlays (infrastructure origin/staging)", grep(infra, ["*overlays*/*staging*/*"], "origin/staging"));
} else console.log("\n## Infrastructure: no checkout found (set LLEVERAGE_INFRA_REPO); environment flags not checked");
console.log("\nAlso check the change is deployed: merged today is not necessarily live (Argo sync, or the prod-health skill's recent deploys).");
