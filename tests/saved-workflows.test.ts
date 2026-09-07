import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runWorkflowSandbox, type SandboxHost } from "../extensions/workflows/sandbox.ts";
import { validateScript } from "../extensions/workflows/script-format.ts";

const root = path.resolve(import.meta.dir, "..");
const source = (name: string) => readFileSync(path.join(root, ".pi/workflows", `${name}.ts`), "utf8");
const head = "a".repeat(40);
const base = "b".repeat(40);
const budget = { total: null, spent: 0, remaining: null };
type Call = { prompt: string; opts: any };
type Handler = (call: Call) => unknown | Promise<unknown>;

async function run(name: string, args: unknown, handler: Handler, calls: Call[] = []): Promise<any> {
  const text = source(name);
  expect(validateScript(text)).toEqual([]);
  const host: SandboxHost = {
    async agent(payload) {
      const call = { prompt: String(payload.prompt), opts: payload.opts as any };
      calls.push(call);
      return { value: await handler(call), budget };
    },
    async phase() { return {}; }, async log() { return {}; },
    async workflow() { throw new Error("unexpected nested workflow"); },
  };
  return runWorkflowSandbox({ source: text, fileName: `${name}.ts`, args, budget, host, signal: new AbortController().signal, timeoutMs: 10_000 });
}

function context() {
  return { ok: true, error: "", baseOid: base, headOid: head, baseRef: "main", headRef: "feature", title: "Fixture PR", changedFiles: ["src/file.ts"], diffSummary: "changes behaviour", priorDiscussion: "none", ticket: { id: "TASK-1", found: true, summary: "Acceptance criterion" }, verification: { status: "passed", reason: "Required CI checked at reviewed head", headOid: head, checks: ["unit: success at " + head] } };
}
const finding = (severity: string) => ({ severity, confidence: 95, file: "src/file.ts", lines: "10", title: "Concrete defect", what: "Wrong result", why: "Reachable impact", fix: "Correct predicate", dimension: "correctness" });
function reviewer(overrides: Record<string, unknown> = {}): Handler {
  return ({ opts }) => {
    if (Object.hasOwn(overrides, opts.label)) return overrides[opts.label];
    if (opts.label === "context") return context();
    if (opts.label.startsWith("review-")) return { dimension: opts.label.slice(7), status: "passed", reason: "Completed assessment", filesReviewed: ["src/file.ts"], findings: [] };
    if (opts.label.startsWith("verify-")) return { real: true, confidence: 95, reasoning: "Independently traced reachable path", adjustedSeverity: "SHOULD_FIX" };
    throw new Error("unexpected call: " + opts.label);
  };
}

describe("saved review-pr contract (mocked child capabilities, no models)", () => {
  test("post:true is rejected before launching any children", async () => {
    const calls: Call[] = [];
    await expect(run("review-pr", { pr: 1, post: true }, reviewer(), calls)).rejects.toThrow("report-only");
    expect(calls).toEqual([]);
  });

  test("all findings/coverage cases match the bundled severity contract", async () => {
    const reference = readFileSync(path.join(root, "skills/general/pr-review/references/severity-verdict.md"), "utf8");
    const functionText = reference.match(/```js\n([\s\S]*?)\n```/)?.[1];
    expect(functionText).toBeDefined();
    expect(source("review-pr")).toContain(functionText!);
    for (const [severity, expected] of [["", "APPROVE"], ["SUGGESTION", "APPROVE_WITH_SUGGESTIONS"], ["SHOULD_FIX", "CHANGES_SUGGESTED"], ["CRITICAL", "REQUEST_CHANGES"]]) {
      const overrides = severity ? {
        "review-correctness": { dimension: "correctness", status: "passed", reason: "complete", filesReviewed: ["src/file.ts"], findings: [finding(severity)] },
        "verify-correctness-1": { real: true, confidence: 95, reasoning: "Confirmed", adjustedSeverity: severity },
      } : {};
      const result = await run("review-pr", 1, reviewer(overrides));
      expect(result.verdict).toBe(expected);
      expect(result.coverageComplete).toBe(true);
      expect(result.report).toContain(`Verdict: ${expected}`);
      expect(result.report).toContain("nothing published");
    }
  });

  test("synthetic missing/malformed/failed reviewers never become full approvals", async () => {
    for (const result of [null, {}, { dimension: "security", status: "failed", reason: "Tool failed", filesReviewed: [], findings: [] }, { dimension: "security", status: "passed", filesReviewed: [], findings: [] }]) {
      const report = await run("review-pr", 1, reviewer({ "review-security": result }));
      expect(report.verdict).toBe("INCOMPLETE");
      expect(report.coverageComplete).toBe(false);
      expect(report.coverage.find((c: any) => c.dimension === "security").status).not.toBe("passed");
    }
  });

  test("ordinary throwing capability failure propagates rather than pretending runtime returned null", async () => {
    const normal = reviewer();
    await expect(run("review-pr", 1, (call) => {
      if (call.opts.label === "review-security") throw new Error("ordinary child failure");
      return normal(call);
    })).rejects.toThrow("ordinary child failure");
  });

  test("missing or contradictory finding verification leaves coverage incomplete", async () => {
    for (const verdict of [null, { real: false, adjustedSeverity: "SHOULD_FIX", reasoning: "contradictory" }]) {
      const result = await run("review-pr", 1, reviewer({
        "review-correctness": { dimension: "correctness", status: "passed", reason: "complete", filesReviewed: ["src/file.ts"], findings: [finding("CRITICAL")] },
        "verify-correctness-1": verdict,
      }));
      expect(result.verdict).toBe("INCOMPLETE");
      expect(result.coverageComplete).toBe(false);
    }
  });

  test("referenced inaccessible ticket differs from no-ticket optional skip", async () => {
    for (const id of ["", "TASK-1"]) {
      const ctx = context();
      ctx.ticket = { id, found: false, summary: id ? "Ticket tool unavailable" : "No reference" };
      const calls: Call[] = [];
      const result = await run("review-pr", 1, reviewer({ context: ctx }), calls);
      expect(result.verdict).toBe(id ? "INCOMPLETE" : "APPROVE");
      expect(result.coverage.find((c: any) => c.dimension === "ticket").status).toBe(id ? "unavailable" : "skipped");
      expect(calls.some((call) => call.opts.label === "review-ticket")).toBe(false);
    }
  });

  test("missing/pending/stale/failed CI cannot yield approval, but a known critical is retained", async () => {
    for (const verification of [null, { ...context().verification, status: "unavailable", reason: "Pending" }, { ...context().verification, headOid: base }, { ...context().verification, checks: [] }, { ...context().verification, status: "failed" }]) {
      const result = await run("review-pr", 1, reviewer({ context: { ...context(), verification } }));
      expect(result.verdict).toBe("INCOMPLETE");
    }
    const result = await run("review-pr", 1, reviewer({
      "review-security": null,
      "review-correctness": { dimension: "correctness", status: "passed", reason: "complete", filesReviewed: ["src/file.ts"], findings: [finding("CRITICAL")] },
      "verify-correctness-1": { real: true, confidence: 95, reasoning: "Confirmed", adjustedSeverity: "CRITICAL" },
    }));
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.coverageComplete).toBe(false);
    expect(result.report).toContain("INCOMPLETE");
  });
});

function debugHandler(overrides: Record<string, unknown> = {}): Handler {
  return ({ opts }) => {
    if (Object.hasOwn(overrides, opts.label)) return overrides[opts.label];
    if (opts.label === "reproduce") return { reproduced: true, command: "test-fixture", exactOutput: "failed", failureSignature: "wrong result", notes: "safe fixture" };
    if (opts.label.startsWith("map-")) return { summary: "code map", locations: [], recentChanges: [] };
    if (opts.label === "hypothesize") return { hypotheses: [{ id: "H1", title: "Root cause", mechanism: "predicate", category: "logic", evidence: [] }] };
    if (opts.label.startsWith("refute-")) return { verdict: "survives", confidence: 0.95, reasoning: "traced", checkedEvidence: "source read" };
    if (opts.label.startsWith("fix-attempt-")) return { value: { implemented: true, summary: "fixed", changedFiles: ["file.ts"], baseHead: base, selfCheck: "pass" }, agentId: opts.label, workspacePath: "/run/workspaces/" + opts.label, diffPath: "/run/worktree-diffs/" + opts.label + ".diff" };
    if (opts.label.startsWith("verify-fix-")) return { value: { addressesRootCause: true, rerunGreen: true, regressionRisk: "low", rerunCommand: "test-fixture", rerunOutput: "pass", summary: "verified", baseHead: base }, agentId: opts.label, workspacePath: null, diffPath: null };
    throw new Error("unexpected debug call: " + opts.label);
  };
}

describe("saved debug-issue exact patch verification", () => {
  test("returns the runtime-preserved patch that was supplied to the verifier", async () => {
    const calls: Call[] = [];
    const result = await run("debug-issue", "bug", debugHandler(), calls);
    expect(result.verification.confirmed).toBe(true);
    const verify = calls.find((call) => call.opts.label === "verify-fix-1")!;
    expect(verify.opts.patches).toEqual([result.fix.diffPath]);
    expect(result.verification.verifiedPatchPath).toBe(result.fix.diffPath);
    expect(result.verification.baseHead).toBe(result.fix.baseHead);
    expect(verify.opts.returnMetadata).toBe(true);
    expect(verify.prompt).toContain("Do NOT apply another diff, reimplement");
    expect(result.fix.diff).toBeUndefined(); // no model-reconstructed patch returned
  });

  test("a substitute verifier patch or mismatched base is never certified", async () => {
    const valid: any = await debugHandler()({ prompt: "", opts: { label: "verify-fix-1" } });
    for (const verifier of [{ ...valid, workspacePath: "/substitute", diffPath: "/substitute.diff" }, { ...valid, value: { ...valid.value, baseHead: head } }, null]) {
      const calls: Call[] = [];
      const result = await run("debug-issue", "bug", debugHandler({ "verify-fix-1": verifier }), calls);
      expect(result.verification.confirmed).toBe(false);
      expect(result.verification.verifiedPatchPath).toBeNull();
      expect(calls.filter((call) => call.opts.label.startsWith("fix-attempt-")).length).toBe(1);
    }
  });

  test("patch seeding failure propagates, with no replacement verification", async () => {
    const normal = debugHandler();
    const calls: Call[] = [];
    await expect(run("debug-issue", "bug", (call) => {
      if (call.opts.label === "verify-fix-1") throw new Error("git apply failed before child launch");
      return normal(call);
    }, calls)).rejects.toThrow("git apply failed");
    expect(calls.filter((call) => call.opts.label.startsWith("fix-attempt-")).length).toBe(1);
  });

  test("no preserved patch stops on no progress", async () => {
    const result = await run("debug-issue", "bug", debugHandler({ "fix-attempt-1": { value: { implemented: true, baseHead: base }, workspacePath: null, diffPath: null } }));
    expect(result.verification.confirmed).toBe(false);
    expect(result.fix).toBeNull();
  });

  test("at most two rejected patches; final evidence belongs to the final patch", async () => {
    const normal = debugHandler();
    const calls: Call[] = [];
    const result = await run("debug-issue", "bug", async (call) => {
      const value: any = await normal(call);
      if (call.opts.label.startsWith("verify-fix-")) value.value.rerunGreen = false;
      return value;
    }, calls);
    expect(result.verification.confirmed).toBe(false);
    expect(calls.filter((call) => call.opts.label.startsWith("fix-attempt-")).length).toBe(2);
    expect(result.fix.diffPath).toContain("fix-attempt-2.diff");
    expect(result.verification.verifiedPatchPath).toBe(result.fix.diffPath);
  });

  test("real runtime pins launch base/patch, detects substitution and rejects invalid patches", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "workflow-patch-home-"));
    try {
      const { stdout } = await promisify(execFile)("bun", [path.join(root, "tests/fixtures/workflow-patch-check.ts")], {
        cwd: root, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_CONFIG_HOME: path.join(home, ".config") }, timeout: 30_000,
      });
      const checks = JSON.parse(stdout.trim());
      expect(Object.keys(checks).length).toBe(8);
      for (const [name, value] of Object.entries(checks)) expect(value, name).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 35_000);
});

function implementHandler(): Handler {
  return ({ opts }) => {
    switch (opts.label) {
      case "fetch-ticket": return { resolved: false, source: "description", title: "Fixture", description: "Fix behaviour", acceptanceCriteria: ["correct"], outOfScope: [], openQuestions: [] };
      case "map-code": return { testCommand: "fixture-test", affectedPaths: [], conventions: [], existingTests: [], integrationPoints: [], notes: "" };
      case "triage": return { inputType: "change-request", baseBranch: "main", existingBranch: "", existingPr: "", relatedIssues: [], tooBigForOnePr: false, suggestedSubtasks: [], branchName: "fix-fixture", rationale: "bounded" };
      case "implement": return { value: JSON.stringify({ filesChanged: ["file.ts"], testsAdded: ["file.test.ts"], testCommandRun: "fixture-test", testsPassed: true, testOutputTail: "implementer output", summary: "fixed" }), workspacePath: "/run/implement", diffPath: "/run/worktree-diffs/implement.diff" };
      case "fix-pass": return null;
    }
    if (opts.label.startsWith("approach-")) return { style: "minimal", summary: "Plan", steps: [], filesToChange: [], testsToAdd: [], risks: [] };
    if (opts.label.startsWith("judge-")) return { score: 9, reasoning: "good" };
    if (opts.label.startsWith("review-")) {
      const owner = opts.label === "review-regression-risk";
      return { lens: opts.label.slice(7), verdict: "pass", issues: [], verification: { status: owner ? "passed" : "not-run", command: owner ? "fixture-test" : "", outputTail: owner ? "independent output" : "" } };
    }
    if (opts.label === "synthesize-plan") return { title: "Fixture", rationale: "bounded", steps: [], filesToChange: [], testsToAdd: [], verificationPlan: [], outOfScope: [] };
    throw new Error("unexpected implementation call: " + opts.label);
  };
}

describe("implement-ticket verification ownership", () => {
  test("deep approach panel remains; only regression-risk owns repeated execution", async () => {
    const calls: Call[] = [];
    const result = await run("implement-ticket", { noPr: true, task: "fixture" }, implementHandler(), calls);
    expect(calls.filter((c) => c.opts.label.startsWith("approach-")).length).toBe(3);
    expect(calls.filter((c) => c.opts.label.startsWith("judge-")).length).toBe(9);
    expect(calls.find((c) => c.opts.label === "review-correctness")!.prompt).toContain("Do not rerun the suite");
    expect(calls.find((c) => c.opts.label === "review-test-adequacy")!.prompt).toContain("Do not rerun the suite");
    expect(calls.find((c) => c.opts.label === "review-regression-risk")!.prompt).toContain("single independent execution owner");
    expect(result.testResult.passed).toBe(true);
    expect(result.testResult.outputTail).toBe("independent output");
    expect(calls.some((c) => c.opts.label === "ship-pr")).toBe(false);
  });

  test("implementer green cannot substitute for missing independent execution evidence", async () => {
    const normal = implementHandler();
    const result = await run("implement-ticket", { noPr: true, task: "fixture" }, async (call) => {
      if (call.opts.label === "review-regression-risk") return null;
      return normal(call);
    });
    expect(result.testResult.passed).toBe(false);
    expect(result.reviewVerdict).not.toBe("pass");
  });
});
