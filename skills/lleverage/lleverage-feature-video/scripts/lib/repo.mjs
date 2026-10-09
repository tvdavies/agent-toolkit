// Where the Lleverage checkouts are. The app repo gives facts, flags and icons; the infrastructure repo gives
// the environment flags each deployment actually sets.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const first = (...c) => c.find((p) => p && existsSync(p));
export function appRepo() {
  const r = first(process.env.LLEVERAGE_REPO, path.join(homedir(), "dev/lleverage-ai/lleverage"), path.join(homedir(), "Sites/lleverage"), path.join(homedir(), "lleverage"));
  if (!r || !existsSync(path.join(r, "apps/app"))) { console.error("No lleverage checkout found. Set LLEVERAGE_REPO=/path/to/lleverage."); process.exit(2); }
  return r;
}
export function infraRepo() {
  return first(process.env.LLEVERAGE_INFRA_REPO, path.join(homedir(), "dev/lleverage-ai/infrastructure"), path.join(homedir(), "Sites/infrastructure")) || null;
}
