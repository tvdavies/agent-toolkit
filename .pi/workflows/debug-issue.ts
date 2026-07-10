export const meta = {
  version: 2,
  name: "debug-issue",
  description:
    "Debug a failing test, error/stack trace, or bug report and propose a verified minimal fix. Reproduces the failure and maps the code in parallel, generates several diverse root-cause hypotheses each backed by concrete file:line evidence, has independent skeptics adversarially try to refute each hypothesis (defaulting to refuted when uncertain), then implements the minimal fix for the surviving root cause in an isolated worktree and verifies it re-runs the failing command green with no obvious regressions. Returns { reproduced, rootCause, fix, verification }.",
  phases: [
    { title: "Reproduce + Map", detail: "Reproduce the failure exactly and map the implicated code paths, logs, and recent changes in parallel." },
    { title: "Hypothesize", detail: "Generate several diverse candidate root causes, each grounded in concrete file:line code evidence." },
    { title: "Verify (adversarial)", detail: "Independent skeptics try to refute each hypothesis against the real code; keep only those that survive a refute-by-default majority." },
    { title: "Fix + Verify", detail: "Implement the minimal fix for the confirmed root cause in an isolated worktree, then independently re-run the failing command to confirm green with no regressions." },
  ],
};

const issue = typeof args === "string" ? args.trim() : JSON.stringify(args ?? "");
if (!issue) {
  return {
    reproduced: false,
    rootCause: null,
    fix: null,
    verification: { confirmed: false, summary: "No issue description was provided to debug-issue. Pass a failing test name, an error/stack trace, or a bug report as args." },
  };
}

// ---------------------------------------------------------------------------
// PHASE 1 — Reproduce + Map (parallel barrier: hypothesizing needs BOTH the
// concrete reproduction AND the code map together, so we wait for the whole set).
// ---------------------------------------------------------------------------
phase("Reproduce + Map");
log("Reproducing the failure and mapping the implicated code in parallel.");

const reproSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reproduced", "command", "exactOutput", "failureSignature", "notes"],
  properties: {
    reproduced: { type: "boolean", description: "True only if you actually ran something and observed the described failure." },
    command: { type: "string", description: "The exact command you ran to reproduce (or the closest reproduction you found)." },
    exactOutput: { type: "string", description: "The verbatim relevant failing output / assertion / stack trace (trim to the salient lines, do not paraphrase)." },
    failureSignature: { type: "string", description: "A one-line canonical signature of the failure (error type + message + top frame, or assertion that failed)." },
    notes: { type: "string", description: "How you reproduced, any setup needed, flakiness observed, or why it could not be reproduced." },
  },
};

const mapSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "locations", "recentChanges"],
  properties: {
    summary: { type: "string", description: "What this lens found about the failure's neighbourhood." },
    locations: {
      type: "array",
      description: "Concrete code locations relevant to the failure.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "why"],
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          why: { type: "string", description: "Why this location is relevant to the failure." },
        },
      },
    },
    recentChanges: {
      type: "array",
      description: "Recent commits/changes (git log/blame) plausibly related to the failure.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "summary", "relevance"],
        properties: {
          ref: { type: "string", description: "Commit hash / ref / PR." },
          summary: { type: "string" },
          relevance: { type: "string" },
        },
      },
    },
  },
};

const mapLenses = [
  {
    label: "map-callpath",
    focus:
      "Map the runtime CALL PATH that leads to the failure: the entry point (test or command), the functions it calls, and where control reaches the failing assertion/error. Read the actual source files. Record exact file:line locations.",
  },
  {
    label: "map-data-state",
    focus:
      "Map the DATA and STATE involved: the inputs, fixtures, config, environment, shared/global state, and any I/O (files, network, db, time, randomness) the failing code depends on. Record exact file:line where each is read or mutated.",
  },
  {
    label: "map-history",
    focus:
      "Map the RECENT HISTORY around the failure using `git log`, `git blame`, and `git diff`. Identify recent commits touching the failing files or their dependencies, and blame the precise failing lines. Record refs and what changed.",
  },
];

const [repro, ...maps] = await parallel([
  () =>
    agent(
      [
        "You are reproducing a reported failure. DO NOT modify any files; only run/read.",
        "Issue to reproduce:",
        issue,
        "",
        "Steps:",
        "1. Identify the exact test/command implied by the issue (a test name, a build/run command, or the repro steps in a bug report). Inspect the repo (package.json scripts, test config, Makefile, etc.) to find the right invocation.",
        "2. Run it and capture the VERBATIM failing output. If it needs setup (install/build), do the minimum needed.",
        "3. If it does not fail on the first try, try the most plausible exact invocation a developer would use; note any flakiness.",
        "Report whether you genuinely observed the failure, the exact command, the verbatim relevant output, a one-line failure signature, and notes.",
        "Be precise and literal — downstream agents will rely on your exactOutput and failureSignature.",
      ].join("\n"),
      { label: "reproduce", phase: "Reproduce + Map", schema: reproSchema, effort: "high", agentType: "scout", network: true },
    ),
  ...mapLenses.map(
    (lens) => () =>
      agent(
        [
          "You are mapping the code around a reported failure. DO NOT modify any files; only read/inspect and run git/read-only commands.",
          "Issue:",
          issue,
          "",
          "Your lens:",
          lens.focus,
          "",
          "Ground every claim in the real source: open the files, cite exact file:line. Prefer fewer, precise locations over a broad list. If a location is irrelevant, omit it.",
        ].join("\n"),
        { label: lens.label, phase: "Reproduce + Map", schema: mapSchema, effort: "high", agentType: "scout" },
      ),
  ),
]);

const reproResult = repro && typeof repro === "object" ? repro : { reproduced: false, command: "", exactOutput: "", failureSignature: issue.slice(0, 200), notes: "Reproduction agent did not return a result." };
const mapResults = maps.filter(Boolean);

const mapDigest = mapResults
  .map((m, i) => {
    const locs = Array.isArray(m.locations) ? m.locations.map((l) => `    - ${l.file}:${l.line} — ${l.why}`).join("\n") : "    (none)";
    const hist = Array.isArray(m.recentChanges) && m.recentChanges.length
      ? m.recentChanges.map((c) => `    - ${c.ref}: ${c.summary} (${c.relevance})`).join("\n")
      : "    (none)";
    return `Map lens #${i + 1}: ${m.summary}\n  Locations:\n${locs}\n  Recent changes:\n${hist}`;
  })
  .join("\n\n");

const reproDigest = [
  `reproduced: ${reproResult.reproduced}`,
  `command: ${reproResult.command}`,
  `failureSignature: ${reproResult.failureSignature}`,
  `exactOutput:\n${reproResult.exactOutput}`,
  `notes: ${reproResult.notes}`,
].join("\n");

log(`Reproduced: ${reproResult.reproduced}. Gathered ${mapResults.length} code maps.`);

// ---------------------------------------------------------------------------
// PHASE 2 — Hypothesize (generate several DIVERSE candidate root causes, each
// with concrete file:line evidence). One agent emits a diverse set so the
// candidates are deliberately non-overlapping.
// ---------------------------------------------------------------------------
phase("Hypothesize");
log("Generating diverse candidate root causes grounded in code evidence.");

const hypothesesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hypotheses"],
  properties: {
    hypotheses: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      description: "Diverse, non-overlapping candidate root causes. Each must be grounded in concrete code evidence, not a guess.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "mechanism", "evidence", "category"],
        properties: {
          id: { type: "string", description: "Short stable id, e.g. H1, H2." },
          title: { type: "string", description: "One-line statement of the candidate root cause." },
          category: { type: "string", description: "The class of bug, e.g. off-by-one, null/undefined, race, type-coercion, bad-config, regression, wrong-assumption-in-test, resource-leak." },
          mechanism: { type: "string", description: "The concrete causal chain from this defect to the observed failureSignature." },
          evidence: {
            type: "array",
            minItems: 1,
            description: "Concrete code evidence (file:line) that makes this hypothesis plausible.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["file", "line", "quote", "why"],
              properties: {
                file: { type: "string" },
                line: { type: "integer" },
                quote: { type: "string", description: "The actual code/text at that line (verbatim)." },
                why: { type: "string", description: "How this line supports the hypothesis and connects to the failure." },
              },
            },
          },
        },
      },
    },
  },
};

const hypothesisOut = await agent(
  [
    "You are a senior debugger. Given a reproduced failure and a code map, propose SEVERAL DIVERSE candidate root causes.",
    "Hard rules:",
    "- Diversity: each hypothesis must point at a genuinely different mechanism/location. Do not restate one idea three ways.",
    "- Grounded: every hypothesis must cite concrete code evidence (file:line with the actual code at that line). Re-read the file to confirm the quote is real. No speculation without code.",
    "- Each hypothesis must explain the causal chain to THIS exact failure signature.",
    "- Include at least one hypothesis that questions whether the TEST/expectation itself is wrong (if plausible), and one regression candidate tied to a recent change (if any).",
    "",
    "Failure (reproduction):",
    reproDigest,
    "",
    "Code map:",
    mapDigest,
    "",
    "Original issue text:",
    issue,
  ].join("\n"),
  { label: "hypothesize", phase: "Hypothesize", schema: hypothesesSchema, effort: "max", agentType: "scout" },
);

const hypotheses = hypothesisOut && Array.isArray(hypothesisOut.hypotheses) ? hypothesisOut.hypotheses.filter(Boolean) : [];

if (hypotheses.length === 0) {
  log("No grounded hypotheses were produced; cannot propose a verified fix.");
  return {
    reproduced: !!reproResult.reproduced,
    rootCause: null,
    fix: null,
    verification: {
      confirmed: false,
      summary: "Reproduction/mapping completed but no code-grounded root-cause hypothesis could be generated. Manual investigation needed.",
      reproductionCommand: reproResult.command,
      failureSignature: reproResult.failureSignature,
    },
  };
}

log(`Generated ${hypotheses.length} candidate root cause(s): ${hypotheses.map((h) => h.id).join(", ")}.`);

// ---------------------------------------------------------------------------
// PHASE 3 — Verify (adversarial). Each hypothesis flows through the pipeline
// independently: N independent skeptics try to REFUTE it against the real code,
// defaulting to refuted when uncertain. A hypothesis survives only if a MAJORITY
// of skeptics fail to refute it (i.e. confirm it withstands scrutiny).
// pipeline() runs hypotheses concurrently with no barrier between stages.
// ---------------------------------------------------------------------------
phase("Verify (adversarial)");
log(`Adversarially testing ${hypotheses.length} hypothesis/es with independent skeptics (refute-by-default).`);

const SKEPTICS_PER_HYPOTHESIS = 3;

const refutationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "reasoning", "checkedEvidence"],
  properties: {
    verdict: {
      type: "string",
      enum: ["refuted", "survives"],
      description: "'refuted' if you found the hypothesis does NOT explain the failure or its evidence is wrong/irrelevant; 'survives' ONLY if it genuinely withstands your attempt to break it. Default to 'refuted' when uncertain.",
    },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "Your confidence in the verdict (0-1)." },
    reasoning: { type: "string", description: "How you tried to refute it and what you actually found in the code." },
    checkedEvidence: { type: "string", description: "Whether the cited file:line evidence was real and actually supports the hypothesis (you must have re-read it)." },
  },
};

const verified = await pipeline(
  hypotheses,
  // Stage 1: run independent skeptics against this single hypothesis (internal barrier on its own skeptics only).
  async (hypothesis, _orig, index) => {
    const evidenceText = Array.isArray(hypothesis.evidence)
      ? hypothesis.evidence.map((e) => `  - ${e.file}:${e.line} :: ${e.quote}\n    (claim: ${e.why})`).join("\n")
      : "  (no evidence)";
    const verdicts = await parallel(
      Array.from({ length: SKEPTICS_PER_HYPOTHESIS }, (_unused, s) => () =>
        agent(
          [
            "You are an adversarial skeptic. Your job is to REFUTE the following root-cause hypothesis, not to confirm it.",
            "Open the cited files and read the actual code. Try to break the causal chain: is the evidence real? Does the mechanism actually produce THIS failure signature? Is there a simpler/contradicting explanation? Would the failure still occur if this hypothesis were false?",
            "Rules: Default to 'refuted' when uncertain or when the evidence does not clearly support the claim. Only return 'survives' if the hypothesis genuinely withstands a real attempt to break it against the code.",
            "DO NOT modify files; only read/inspect and run read-only checks.",
            "",
            `Hypothesis ${hypothesis.id}: ${hypothesis.title}`,
            `Category: ${hypothesis.category}`,
            `Proposed mechanism: ${hypothesis.mechanism}`,
            "Cited evidence:",
            evidenceText,
            "",
            "Failure being explained:",
            reproDigest,
            `Skeptic seed: ${index}-${s} (use a distinct angle of attack from other skeptics).`,
          ].join("\n"),
          { label: `refute-${hypothesis.id}-${s + 1}`, phase: "Verify (adversarial)", schema: refutationSchema, effort: "high", agentType: "scout" },
        ),
      ),
    );
    const valid = verdicts.filter((v) => v && typeof v === "object" && (v.verdict === "refuted" || v.verdict === "survives"));
    const survivesVotes = valid.filter((v) => v.verdict === "survives").length;
    const refutedVotes = valid.filter((v) => v.verdict === "refuted").length;
    // Refute-by-default: survive only on a strict majority of valid skeptics, and require at least one valid vote.
    const survived = valid.length > 0 && survivesVotes > refutedVotes;
    const avgSurviveConfidence = valid.length
      ? valid.filter((v) => v.verdict === "survives").reduce((a, v) => a + (Number(v.confidence) || 0), 0) / Math.max(1, survivesVotes)
      : 0;
    return {
      hypothesis,
      survived,
      survivesVotes,
      refutedVotes,
      totalVotes: valid.length,
      score: survived ? avgSurviveConfidence + survivesVotes * 0.1 : -1,
      verdicts: valid,
    };
  },
);

const survivors = verified
  .filter(Boolean)
  .filter((v) => v.survived)
  .sort((a, b) => b.score - a.score);

log(
  `Adversarial verification: ${survivors.length}/${verified.filter(Boolean).length} hypothesis/es survived. ` +
    survivors.map((s) => `${s.hypothesis.id}(${s.survivesVotes}/${s.totalVotes})`).join(", "),
);

if (survivors.length === 0) {
  return {
    reproduced: !!reproResult.reproduced,
    rootCause: null,
    fix: null,
    verification: {
      confirmed: false,
      summary:
        "No root-cause hypothesis survived adversarial verification (refute-by-default). The candidates and why they were refuted are below; a deeper or differently-scoped investigation is needed before a fix can be trusted.",
      reproductionCommand: reproResult.command,
      failureSignature: reproResult.failureSignature,
      refutedCandidates: verified.filter(Boolean).map((v) => ({
        id: v.hypothesis.id,
        title: v.hypothesis.title,
        survivesVotes: v.survivesVotes,
        refutedVotes: v.refutedVotes,
        topReason: (v.verdicts.find((x) => x.verdict === "refuted") || {}).reasoning || "",
      })),
    },
  };
}

const confirmed = survivors[0];
log(`Confirmed root cause: ${confirmed.hypothesis.id} — ${confirmed.hypothesis.title}`);

// ---------------------------------------------------------------------------
// PHASE 4 — Fix + Verify. Implement the MINIMAL fix in an isolated worktree
// (mutating agent => isolation:'worktree'), then an INDEPENDENT verifier checks
// the fix addresses the confirmed cause and re-runs the failing command to
// confirm green with no obvious regressions. Iterate (bounded) if verification
// fails and budget allows.
// ---------------------------------------------------------------------------
phase("Fix + Verify");
log("Implementing the minimal fix in an isolated worktree, then verifying it.");

const fixSchema = {
  type: "object",
  additionalProperties: false,
  required: ["implemented", "summary", "changedFiles", "diff", "selfCheck"],
  properties: {
    implemented: { type: "boolean", description: "True if you actually applied the fix to files in your worktree." },
    summary: { type: "string", description: "What the minimal fix does and why it addresses the confirmed root cause." },
    changedFiles: { type: "array", items: { type: "string" }, description: "Files you modified." },
    diff: { type: "string", description: "The unified diff of your change (git diff). Keep it minimal." },
    selfCheck: { type: "string", description: "What you ran in the worktree and what you observed (e.g. the previously-failing command now passes)." },
  },
};

const verifySchema = {
  type: "object",
  additionalProperties: false,
  required: ["addressesRootCause", "rerunGreen", "regressionRisk", "rerunCommand", "rerunOutput", "summary"],
  properties: {
    addressesRootCause: { type: "boolean", description: "Does the diff actually fix the CONFIRMED root cause (not just mask the symptom)?" },
    rerunGreen: { type: "boolean", description: "Did the previously-failing test/command pass after applying the diff?" },
    regressionRisk: {
      type: "string",
      enum: ["none", "low", "medium", "high"],
      description: "Risk that this change breaks something else, based on related tests you ran and the blast radius you inspected.",
    },
    rerunCommand: { type: "string", description: "The exact command you re-ran to verify." },
    rerunOutput: { type: "string", description: "The verbatim relevant output of the re-run (showing pass/fail)." },
    summary: { type: "string", description: "Verdict and any caveats." },
  },
};

const evidenceForFix = Array.isArray(confirmed.hypothesis.evidence)
  ? confirmed.hypothesis.evidence.map((e) => `  - ${e.file}:${e.line} :: ${e.quote}`).join("\n")
  : "  (none)";

const fixContext = [
  `Confirmed root cause (${confirmed.hypothesis.id}): ${confirmed.hypothesis.title}`,
  `Category: ${confirmed.hypothesis.category}`,
  `Mechanism: ${confirmed.hypothesis.mechanism}`,
  "Key evidence:",
  evidenceForFix,
  "",
  "Failure to fix:",
  reproDigest,
].join("\n");

const MAX_FIX_ATTEMPTS = 2;
let fixResult = null;
let verification = null;
let priorFeedback = "";

for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
  if (budget.total != null && budget.remaining() <= 0) {
    log("Token budget exhausted before completing fix verification; stopping.");
    break;
  }

  const fix = await agent(
    [
      "You are fixing a confirmed bug. Implement the SMALLEST correct change that addresses the root cause below.",
      "Rules: minimal diff (no unrelated refactors, no reformatting); fix the CAUSE, not the symptom; keep existing behaviour for everything unrelated.",
      "Then, in your worktree, re-run the previously-failing command and confirm it now passes. Capture `git diff`.",
      "",
      fixContext,
      priorFeedback ? `\nThe previous fix attempt was rejected by the verifier. Feedback to address:\n${priorFeedback}` : "",
    ].join("\n"),
    { label: `fix-attempt-${attempt}`, phase: "Fix + Verify", schema: fixSchema, effort: "max", isolation: "worktree", agentType: "worker", network: true, allowFailure: true },
  );

  if (!fix || !fix.implemented || !fix.diff || !fix.diff.trim()) {
    priorFeedback = "The fix agent did not produce an applicable diff. Produce a concrete minimal change.";
    fixResult = fix || { implemented: false, summary: "Fix agent produced no diff.", changedFiles: [], diff: "", selfCheck: "" };
    continue;
  }
  fixResult = fix;

  // Independent verifier: applies the proposed diff in ITS OWN clean worktree, re-runs, and judges.
  const verdict = await agent(
    [
      "You are an independent fix verifier. You did NOT write this fix. Be skeptical.",
      "Apply the proposed diff to a clean checkout (in your isolated worktree) with `git apply`. If it does not apply cleanly, re-implement the SAME minimal change yourself from the confirmed root cause below (do not weaken or skip the test). Then:",
      "1. Confirm it actually addresses the CONFIRMED root cause (not merely hides the symptom or deletes/weakens the test).",
      "2. Re-run the exact previously-failing command and check it is now GREEN. Capture verbatim output.",
      "3. Run the most relevant neighbouring tests to gauge regression risk; inspect the blast radius of the change.",
      "If the diff weakens an assertion or skips the test rather than fixing the cause, treat addressesRootCause as false.",
      "",
      "Confirmed root cause and failure:",
      fixContext,
      "",
      "Proposed fix summary:",
      fixResult.summary,
      "Changed files: " + (Array.isArray(fixResult.changedFiles) ? fixResult.changedFiles.join(", ") : ""),
      "Proposed diff to apply:",
      "```diff",
      fixResult.diff,
      "```",
    ].join("\n"),
    { label: `verify-fix-${attempt}`, phase: "Fix + Verify", schema: verifySchema, effort: "max", isolation: "worktree", agentType: "reviewer", network: true, allowFailure: true },
  );

  verification = verdict;
  if (verdict && verdict.addressesRootCause && verdict.rerunGreen && verdict.regressionRisk !== "high") {
    log(`Fix verified on attempt ${attempt}: re-run is green and addresses the root cause.`);
    break;
  }
  priorFeedback = verdict
    ? `addressesRootCause=${verdict.addressesRootCause}, rerunGreen=${verdict.rerunGreen}, regressionRisk=${verdict.regressionRisk}. ${verdict.summary} Re-run output:\n${verdict.rerunOutput}`
    : "The verifier returned no result; ensure the diff applies cleanly and the failing command is re-run.";
  log(`Fix attempt ${attempt} not confirmed; ${attempt < MAX_FIX_ATTEMPTS ? "retrying with feedback." : "out of attempts."}`);
}

const fixConfirmed = !!(verification && verification.addressesRootCause && verification.rerunGreen && verification.regressionRisk !== "high");

return {
  reproduced: !!reproResult.reproduced,
  rootCause: {
    id: confirmed.hypothesis.id,
    title: confirmed.hypothesis.title,
    category: confirmed.hypothesis.category,
    mechanism: confirmed.hypothesis.mechanism,
    evidence: confirmed.hypothesis.evidence,
    adversarialResult: { survivesVotes: confirmed.survivesVotes, refutedVotes: confirmed.refutedVotes, totalVotes: confirmed.totalVotes },
    alternativesConsidered: survivors.slice(1).map((s) => ({ id: s.hypothesis.id, title: s.hypothesis.title })),
  },
  fix: fixResult
    ? { summary: fixResult.summary, changedFiles: fixResult.changedFiles, diff: fixResult.diff, applied: !!fixResult.implemented }
    : null,
  verification: {
    confirmed: fixConfirmed,
    reproductionCommand: reproResult.command,
    failureSignature: reproResult.failureSignature,
    addressesRootCause: verification ? !!verification.addressesRootCause : false,
    rerunGreen: verification ? !!verification.rerunGreen : false,
    regressionRisk: verification ? verification.regressionRisk : "unknown",
    rerunCommand: verification ? verification.rerunCommand : reproResult.command,
    rerunOutput: verification ? verification.rerunOutput : "",
    summary: verification ? verification.summary : "Fix was not verified (no verifier verdict was produced).",
  },
};
