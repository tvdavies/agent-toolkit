import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// pi-xai 0.18.0 ships typebox as a dependency and versioned Pi peers.
// Repair the installed manifest until upstream follows Pi's host-module contract.
// No package code, lockfiles, or physical modules are removed by this workaround.
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
const manifestPath = join(agentDir, "npm", "node_modules", "pi-xai", "package.json");
let source;
try {
  source = await readFile(manifestPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (source !== undefined) {
  const manifest = JSON.parse(source);
  if (manifest.name !== "pi-xai") throw new Error(`Expected pi-xai at ${manifestPath}`);
  const hostPackages = [
    "@earendil-works/pi-ai", "@earendil-works/pi-agent-core",
    "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox",
  ];
  let changed = false;
  for (const name of hostPackages) {
    if (Object.hasOwn(manifest.dependencies ?? {}, name)) {
      delete manifest.dependencies[name];
      manifest.peerDependencies ??= {};
      manifest.peerDependencies[name] = "*";
      changed = true;
    }
    if (Object.hasOwn(manifest.peerDependencies ?? {}, name) && manifest.peerDependencies[name] !== "*") {
      manifest.peerDependencies[name] = "*";
      changed = true;
    }
  }
  if (changed) {
    if (manifest.dependencies && Object.keys(manifest.dependencies).length === 0) delete manifest.dependencies;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Repaired pi-xai host-provided peer dependencies: ${manifestPath}`);
  }
}
