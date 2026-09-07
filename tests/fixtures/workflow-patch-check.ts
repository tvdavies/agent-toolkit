// Local runtime fixture only: no agents/models, network, or GitHub calls.
// The parent test invokes this process with an isolated HOME.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentWorktree, finalizeAgentWorktree, type RunState } from "../../extensions/workflows/index.ts";

const home = os.homedir();
const root = path.join(home, "repo");
fs.mkdirSync(root);
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
git("init", "-q");
git("config", "user.email", "fixture@example.test");
git("config", "user.name", "Fixture");
fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
git("add", ".");
git("commit", "-qm", "base");
const head = git("rev-parse", "HEAD");
fs.writeFileSync(path.join(root, "tracked.txt"), "dirty launch snapshot\n");
const runDir = path.join(home, "run");
fs.mkdirSync(runDir);
const launchPatch = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root, encoding: "utf8" });
const launchPatchPath = path.join(runDir, "launch.diff");
fs.writeFileSync(launchPatchPath, launchPatch);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const run = {
  id: "patch-fixture", name: "fixture", workflowPath: "/fixture.ts", scope: "script", hash: "fixture",
  cwd: root, args: "", status: "running", startedAt: Date.now(), phases: [], agents: [], runDir, eventSeq: 0,
  repositorySnapshot: { root, relativeCwd: ".", head, trackedPatchPath: launchPatchPath, trackedPatchHash: hash(launchPatch), untrackedNames: [], hash: "snapshot" },
} as RunState;
const record = (id: string) => ({ id, label: id, agent: "worker", status: "running", startedAt: Date.now() }) as any;
const fixerRecord = record("fixer");
const fixer = await createAgentWorktree(run, fixerRecord, root);
fs.writeFileSync(path.join(fixer.path, "tracked.txt"), "fixed from launch snapshot\n");
fs.writeFileSync(path.join(fixer.path, "new-test.txt"), "regression fixture\n");
const patch = await finalizeAgentWorktree(run, fixerRecord, fixer);
if (!patch.diffPath) throw new Error("fixture did not preserve a patch");
const patchHash = hash(fs.readFileSync(patch.diffPath, "utf8"));
// Move the source after launch: verifier must still get original base and patch.
fs.writeFileSync(path.join(root, "tracked.txt"), "source moved later\n");
git("add", ".");
git("commit", "-qm", "later source head");
const verifierRecord = record("verifier");
const verifier = await createAgentWorktree(run, verifierRecord, root, [patch.diffPath]);
const verifierHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: verifier.path, encoding: "utf8" }).trim();
const exactContents = fs.readFileSync(path.join(verifier.path, "tracked.txt"), "utf8") === "fixed from launch snapshot\n"
  && fs.readFileSync(path.join(verifier.path, "new-test.txt"), "utf8") === "regression fixture\n";
const sameBaseTree = verifier.baselineTree === fixer.baselineTree;
const unchanged = await finalizeAgentWorktree(run, verifierRecord, verifier);
const substituteRecord = record("substitute");
const substitute = await createAgentWorktree(run, substituteRecord, root, [patch.diffPath]);
fs.writeFileSync(path.join(substitute.path, "tracked.txt"), "a different patch\n");
const replacement = await finalizeAgentWorktree(run, substituteRecord, substitute);
const originalPatchUnchanged = hash(fs.readFileSync(patch.diffPath, "utf8")) === patchHash;
const invalidPath = path.join(runDir, "worktree-diffs", "invalid.diff");
fs.writeFileSync(invalidPath, "not an applicable patch\n");
let applicationRejected = false;
try { await createAgentWorktree(run, record("invalid"), root, [invalidPath]); }
catch { applicationRejected = true; }
console.log(JSON.stringify({
  pinnedHead: verifierHead === head && git("rev-parse", "HEAD") !== head,
  sameBaseTree, exactContents, originalPatchUnchanged,
  unchangedVerifierHasNoPatch: !unchanged.preserved && !unchanged.diffPath,
  substituteHasDistinctPatch: replacement.preserved && replacement.diffPath !== patch.diffPath,
  applicationRejected,
  failedWorkspaceRemoved: !fs.existsSync(path.join(home, ".pi/agent/workflow-workspaces/patch-fixture/invalid")),
}));
