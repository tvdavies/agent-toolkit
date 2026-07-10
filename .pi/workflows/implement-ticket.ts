export const meta = {
  version: 2,
  name: "implement-ticket",
  description:
    "Implement a ticket or bug end-to-end and open a well-described PR. Triages the input like a principal engineer (ticket id or free-form report; detects an existing branch/PR to continue, duplicate/related issues, or a ticket too big for one PR), maps the code, plans via a judge panel, implements in an isolated clone with tests and an adversarial review + bounded fix, then pushes a well-named branch and opens a well-described PR against the base. Surfaces related issues and any recommended breakdown into follow-up PRs. Pass { noPr: true } (or say 'leave it in the worktree') to stop before pushing; { draft: true } for a draft PR.",
  phases: [
    { title: "Understand", detail: "Triage the input (ticket vs report; existing branch/PR; duplicates; size) and, in parallel, fetch the requirement and map the affected code and conventions." },
    { title: "Plan", detail: "Generate independent implementation approaches, score them with parallel judges, and synthesize the winning plan grafting the best ideas from runners-up." },
    { title: "Implement", detail: "Carry out the winning plan in a fresh isolated git clone, writing code and tests and running the repo's test command, scoped to the ticket." },
    { title: "Review", detail: "Independent reviewers across correctness, test-adequacy, and regression-risk try to find real problems and re-run tests; do one bounded fix pass if needed." },
    { title: "Ship", detail: "Commit on a well-named branch, push, and open a well-described PR against the base branch (unless opted out)." },
  ],
};

// ---------------------------------------------------------------------------
// args: a ticket id (Linear like LLE-123, or a tadu id) OR a free-form change
// description. We don't know which up front, so the understand phase tries the
// ticket stores first and falls back to treating args as the change request.
// ---------------------------------------------------------------------------
const request = typeof args === "string" && args.trim()
  ? args.trim()
  : args && typeof args === "object"
    ? JSON.stringify(args)
    : "";

if (!request) {
  log("No ticket id or change description supplied in args.");
  return {
    plan: null,
    worktree: null,
    testResult: null,
    reviewVerdict: "skipped",
    summary: "implement-ticket received empty args. Pass a Linear/tadu ticket id (e.g. LLE-123) or a free-form change description.",
  };
}

// Default: implement AND open a well-described PR (changes go on PRs). Opt out
// to stop at the worktree (args.noPr, or a clear instruction in the text).
const argObj = args && typeof args === "object" ? args : {};
const optedOutOfPr =
  argObj.noPr === true ||
  /\b(leave (it )?in (a |the )?worktree|don'?t (open|create|raise|push) (a )?(pr|pull request|branch)?|no pr|without (a )?pr)\b/i.test(request);
const draftPr = argObj.draft === true || /\bdraft (pr|pull request)\b/i.test(request);

// ===========================================================================
// PHASE 1 — UNDERSTAND (parallel barrier: both halves must land before planning)
// ===========================================================================
phase("Understand");
log(`Understanding request: ${request.slice(0, 140)}`);

const ticketSchema = {
  type: "object",
  additionalProperties: false,
  required: ["resolved", "source", "title", "description", "acceptanceCriteria", "outOfScope", "openQuestions"],
  properties: {
    resolved: { type: "boolean", description: "true if a real ticket was fetched; false if args was treated as a free-form change description" },
    source: { type: "string", enum: ["linear", "tadu", "description"], description: "where the requirement text came from" },
    id: { type: "string", description: "ticket id if resolved, else empty" },
    title: { type: "string" },
    description: { type: "string", description: "the full requirement text, normalized" },
    acceptanceCriteria: { type: "array", items: { type: "string" }, description: "explicit, testable acceptance criteria; infer them if the ticket lacks an explicit list" },
    outOfScope: { type: "array", items: { type: "string" }, description: "things the ticket does NOT ask for, to bound scope" },
    openQuestions: { type: "array", items: { type: "string" }, description: "ambiguities a human may need to resolve; empty if none" },
  },
};

const codeMapSchema = {
  type: "object",
  additionalProperties: false,
  required: ["testCommand", "affectedPaths", "conventions", "existingTests", "integrationPoints", "notes"],
  properties: {
    testCommand: { type: "string", description: "the exact command to run the test suite for this repo (e.g. 'bun test', 'npm test', 'pytest'); 'bun test' if unsure and bun is present" },
    affectedPaths: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "why"],
        properties: { path: { type: "string" }, why: { type: "string" } },
      },
      description: "files/dirs likely needing changes, each with a one-line reason",
    },
    conventions: { type: "array", items: { type: "string" }, description: "code style, framework, naming, error-handling, and test conventions to follow" },
    existingTests: { type: "array", items: { type: "string" }, description: "existing test files relevant to the change, to mirror style and avoid duplication" },
    integrationPoints: { type: "array", items: { type: "string" }, description: "modules, APIs, schemas, or contracts the change must not break" },
    notes: { type: "string", description: "anything else implementers must know (build quirks, gotchas, prior art)" },
  },
};

const triageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["inputType", "baseBranch", "existingBranch", "existingPr", "relatedIssues", "tooBigForOnePr", "suggestedSubtasks", "branchName", "rationale"],
  properties: {
    inputType: { type: "string", enum: ["linear-ticket", "tadu-ticket", "bug-report", "change-request"] },
    baseBranch: { type: "string", description: "the branch this PR should target (the repo default unless the ticket says otherwise)" },
    existingBranch: { type: "string", description: "an existing local/remote branch already holding work for this ticket, or empty if none" },
    existingPr: { type: "string", description: "URL of an existing open PR for this work, or empty" },
    relatedIssues: { type: "array", items: { type: "string" }, description: "duplicate or closely-related tickets/PRs (id + one line) so we don't duplicate work" },
    tooBigForOnePr: { type: "boolean", description: "true if this should be split into multiple PRs" },
    suggestedSubtasks: { type: "array", items: { type: "string" }, description: "if tooBigForOnePr, the recommended slices each shippable as its own PR, smallest/foundational first" },
    branchName: { type: "string", description: "a well-formed branch name for fresh work, following any visible repo convention" },
    rationale: { type: "string" },
  },
};

const [ticket, codeMap, triage] = await parallel([
  () =>
    agent(
      `You are gathering the requirement for a code-implementation task.\n\n` +
        `The user supplied this as the ticket reference or change description:\n"""\n${request}\n"""\n\n` +
        `Steps:\n` +
        `1. If it looks like a ticket id, FETCH the ticket. Try Linear first via the linear-cli tool (e.g. \`linear-cli issue view <ID>\` or the equivalent), then if that fails or is not a Linear id, try \`tadu show <ID>\` from the task store.\n` +
        `2. If neither store returns a matching ticket, OR the input is clearly a free-form description, treat the input text itself as the requirement (source = "description").\n` +
        `3. Extract crisp, testable acceptance criteria. If the ticket has no explicit list, infer them from the description and title. Each criterion must be checkable by a test or a manual step.\n` +
        `4. Note what is explicitly OUT of scope, and any open questions / ambiguities that could change the implementation.\n\n` +
        `Do not write any code. Only read/fetch.`,
      { label: "fetch-ticket", phase: "Understand", schema: ticketSchema, effort: "medium", network: true, githubAuth: true },
    ),
  () =>
    agent(
      `You are mapping the codebase for an upcoming change. Work in the current repository (read-only — do NOT edit anything).\n\n` +
        `The change to implement:\n"""\n${request}\n"""\n\n` +
        `Produce a grounded map:\n` +
        `1. Determine the repo's actual test command. Inspect package.json scripts, the presence of bun.lock / bun, Makefile, pyproject, etc. Prefer the project's own command; use 'bun test' only if that is genuinely how the repo tests.\n` +
        `2. Identify the files and directories most likely to change, each with a one-line reason. Ground every path by actually finding it (grep/list), not guessing.\n` +
        `3. Record the conventions an implementer must follow (style, framework idioms, error handling, how tests are written and located).\n` +
        `4. List existing tests relevant to this area so the implementer mirrors them and avoids duplication.\n` +
        `5. List integration points / contracts the change must not break.\n\n` +
        `Every path and command you report must be verified against the real repo.`,
      { label: "map-code", phase: "Understand", schema: codeMapSchema, effort: "medium" },
    ),
  () =>
    agent(
      `You are TRIAGING a code task before any work starts — size up the situation like a principal engineer. Read-only; do NOT edit or implement.\n\n` +
        `Input:\n"""\n${request}\n"""\n\n` +
        `Establish, grounding each finding in actual command output:\n` +
        `1. inputType: a Linear ticket id (LLE-…), a tadu id, a bug report, or a general change request?\n` +
        `2. baseBranch: the branch this PR should target — the repo default ('git symbolic-ref refs/remotes/origin/HEAD --short', else 'git remote show origin'), unless the ticket specifies otherwise.\n` +
        `3. existingBranch / existingPr: does work already exist? Search local+remote branches ('git branch -a') and open PRs ('gh pr list --search <ticket id or keywords>') for this ticket. If a branch or PR already holds related work, report it — we will CONTINUE it, not duplicate.\n` +
        `4. relatedIssues: duplicate or closely-related tickets/PRs (search Linear via linear-cli and 'gh pr list'/'gh issue list'). List id + one line each so we don't duplicate effort.\n` +
        `5. tooBigForOnePr + suggestedSubtasks: is this too large for one reviewable PR? If so, propose slices each shippable as its own PR, smallest/foundational first.\n` +
        `6. branchName: a well-formed branch name for fresh work, following any visible repo convention (else '<ticket-id-lowercased>-<short-slug>').`,
      { label: "triage", phase: "Understand", schema: triageSchema, effort: "medium", agentType: "scout", network: true, githubAuth: true },
    ),
]);

if (!ticket || !codeMap) {
  log("Understand phase failed to produce both the ticket and the code map.");
  return {
    plan: null,
    worktree: null,
    testResult: null,
    reviewVerdict: "blocked",
    summary:
      "Could not establish a grounded picture: " +
      (!ticket ? "ticket/requirement extraction failed. " : "") +
      (!codeMap ? "codebase mapping failed. " : "") +
      "Re-run with a clearer ticket id or change description.",
  };
}

const testCommand = (codeMap.testCommand && String(codeMap.testCommand).trim()) || "bun test";
const triageInfo = triage || {
  inputType: "change-request",
  baseBranch: "",
  existingBranch: "",
  existingPr: "",
  relatedIssues: [],
  tooBigForOnePr: false,
  suggestedSubtasks: [],
  branchName: "",
  rationale: "(triage unavailable)",
};
log(
  `Resolved test command: ${testCommand}. Acceptance criteria: ${(ticket.acceptanceCriteria || []).length}. ` +
    `Triage: ${triageInfo.inputType}${triageInfo.existingBranch ? `, existing branch ${triageInfo.existingBranch}` : ""}${triageInfo.tooBigForOnePr ? ", large (breakdown recommended)" : ""}.`,
);

// Compact, shared context string handed to every later agent so they all reason
// off the same grounded picture.
const sharedContext =
  `REQUIREMENT (source=${ticket.source}${ticket.id ? `, id=${ticket.id}` : ""}):\n` +
  `Title: ${ticket.title}\n` +
  `Description: ${ticket.description}\n\n` +
  `ACCEPTANCE CRITERIA:\n${(ticket.acceptanceCriteria || []).map((c, i) => `${i + 1}. ${c}`).join("\n") || "(none stated)"}\n\n` +
  `OUT OF SCOPE:\n${(ticket.outOfScope || []).map((c) => `- ${c}`).join("\n") || "(none stated)"}\n\n` +
  `OPEN QUESTIONS:\n${(ticket.openQuestions || []).map((c) => `- ${c}`).join("\n") || "(none)"}\n\n` +
  `CODE MAP:\n` +
  `Test command: ${testCommand}\n` +
  `Affected paths:\n${(codeMap.affectedPaths || []).map((p) => `- ${p.path}: ${p.why}`).join("\n") || "(none mapped)"}\n` +
  `Conventions:\n${(codeMap.conventions || []).map((c) => `- ${c}`).join("\n") || "(none noted)"}\n` +
  `Existing tests:\n${(codeMap.existingTests || []).map((t) => `- ${t}`).join("\n") || "(none found)"}\n` +
  `Integration points:\n${(codeMap.integrationPoints || []).map((t) => `- ${t}`).join("\n") || "(none noted)"}\n` +
  `Notes: ${codeMap.notes || "(none)"}\n\n` +
  `SITUATION (triage):\n` +
  `Input type: ${triageInfo.inputType}\n` +
  `Base branch: ${triageInfo.baseBranch || "(repo default)"}\n` +
  `Existing branch/PR: ${triageInfo.existingBranch || "(none)"}${triageInfo.existingPr ? ` / ${triageInfo.existingPr}` : ""}\n` +
  `Related/duplicate issues: ${(triageInfo.relatedIssues || []).join("; ") || "(none found)"}\n` +
  `Too big for one PR: ${triageInfo.tooBigForOnePr ? `yes — slices: ${(triageInfo.suggestedSubtasks || []).join("; ")}` : "no"}\n` +
  (triageInfo.tooBigForOnePr
    ? `>>> This run must implement only the FIRST/foundational slice as one reviewable PR; keep everything else OUT of scope and let the summary list the remaining slices as follow-up PRs.`
    : "");

// ---------------------------------------------------------------------------
// Helpers for mutating agents. Their human report stays in a fenced JSON block while
// returnMetadata supplies stable workspace/diff identities without scraping display text.
// ---------------------------------------------------------------------------
const extractJsonBlock = (text) => {
  if (typeof text !== "string") return null;
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  let last = null;
  while ((m = fenceRe.exec(text)) !== null) last = m[1];
  const candidates = [];
  if (last != null) candidates.push(last.trim());
  candidates.push(text.trim());
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try next candidate
    }
  }
  return null;
};

const jsonContract = (fields) =>
  `When done, output a SINGLE fenced \`\`\`json code block (and nothing after it) with exactly these keys: ${fields}. ` +
  `Do not wrap any other content in a json code fence. Keep testOutputTail to the last ~40 lines.`;

// ===========================================================================
// PHASE 2 — PLAN (diverse candidates -> parallel judges -> synthesized winner)
// ===========================================================================
phase("Plan");

const approachStyles = [
  {
    key: "mvp-first",
    brief:
      "MVP-FIRST: the smallest correct change that satisfies the acceptance criteria. Minimize surface area and new abstractions; reuse existing helpers; ship the simplest thing that fully passes.",
  },
  {
    key: "risk-first",
    brief:
      "RISK-FIRST: lead with the riskiest/most-uncertain part. Identify the parts most likely to break integration points or have hidden edge cases, and design the change to de-risk those first with defensive handling.",
  },
  {
    key: "test-first",
    brief:
      "TEST-FIRST: derive the test list directly from the acceptance criteria, then design the implementation to make those tests pass. Specify the concrete tests (names + what each asserts) before the code design.",
  },
];

const approachSchema = {
  type: "object",
  additionalProperties: false,
  required: ["style", "summary", "steps", "filesToChange", "testsToAdd", "risks"],
  properties: {
    style: { type: "string" },
    summary: { type: "string", description: "one-paragraph description of the approach" },
    steps: { type: "array", items: { type: "string" }, description: "ordered implementation steps" },
    filesToChange: { type: "array", items: { type: "string" }, description: "concrete files this approach touches" },
    testsToAdd: { type: "array", items: { type: "string" }, description: "concrete tests to add/extend, each naming what it asserts (tied to an acceptance criterion)" },
    risks: { type: "array", items: { type: "string" }, description: "what could go wrong with this approach and how it's mitigated" },
  },
};

const judgeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["correctness", "scope", "risk", "overall", "bestIdea", "weakness"],
  properties: {
    correctness: { type: "integer", minimum: 1, maximum: 5, description: "does it actually satisfy ALL acceptance criteria?" },
    scope: { type: "integer", minimum: 1, maximum: 5, description: "5 = perfectly scoped to the ticket; lower if it does too much or too little" },
    risk: { type: "integer", minimum: 1, maximum: 5, description: "5 = lowest regression/integration risk" },
    overall: { type: "integer", minimum: 1, maximum: 5 },
    bestIdea: { type: "string", description: "the single best idea in this approach worth grafting into the final plan" },
    weakness: { type: "string", description: "the most important weakness or gap" },
  },
};

// Stage 1: generate one candidate per style (independent, in parallel via pipeline fan-out).
// Stage 2: each candidate is scored by its own panel of judges, then we attach the verdict.
const scoredApproaches = (
  await pipeline(
    approachStyles,
    // Stage 1: draft the candidate approach.
    async (style) =>
      agent(
        `Design an implementation approach for the requirement below, using the ${style.brief}\n\n${sharedContext}\n\n` +
          `Stay strictly within scope (respect OUT OF SCOPE). Be concrete: name real files and real tests. Do NOT write code yet — this is a plan.`,
        { label: `approach-${style.key}`, phase: "Plan", schema: approachSchema, effort: "medium", allowFailure: true },
      ),
    // Stage 2: judge this candidate with an independent 3-judge panel (parallel barrier
    // local to this item), average the scores, and attach the verdict.
    async (approach, style, index) => {
      if (!approach) return null;
      const judges = await parallel(
        [0, 1, 2].map((j) => () =>
          agent(
            `You are judge #${j + 1} of an independent panel scoring ONE implementation approach. Be skeptical and score honestly; do not inflate.\n\n` +
              `${sharedContext}\n\n` +
              `APPROACH UNDER REVIEW (${approach.style}):\n${JSON.stringify(approach, null, 2)}\n\n` +
              `Score correctness, scope, and risk (1-5 each) and give an overall (1-5). Name its single best idea and its most important weakness.`,
            { label: `judge-${style.key}-${j + 1}`, phase: "Plan", schema: judgeSchema, effort: "low", allowFailure: true },
          ),
        ),
      );
      const valid = judges.filter(Boolean);
      if (valid.length === 0) return { approach, score: 0, judges: [] };
      const avg = (sel) => valid.reduce((s, v) => s + (Number(sel(v)) || 0), 0) / valid.length;
      const score = avg((v) => v.overall) * 2 + avg((v) => v.correctness) + avg((v) => v.scope) + avg((v) => v.risk);
      return {
        approach,
        score,
        correctness: avg((v) => v.correctness),
        scope: avg((v) => v.scope),
        risk: avg((v) => v.risk),
        judges: valid,
      };
    },
  )
).filter(Boolean);

if (scoredApproaches.length === 0) {
  log("Plan phase produced no scored approaches.");
  return {
    plan: null,
    worktree: null,
    testResult: null,
    reviewVerdict: "blocked",
    summary: "Could not generate any viable implementation approach. The requirement may be too ambiguous; resolve open questions and retry.",
  };
}

scoredApproaches.sort((a, b) => b.score - a.score);
const winner = scoredApproaches[0];
const runnersUp = scoredApproaches.slice(1);
log(`Top approach: ${winner.approach.style} (score ${winner.score.toFixed(2)}). Synthesizing final plan from ${scoredApproaches.length} candidates.`);

// Synthesize the final plan: keep the winner's spine, graft the best ideas from runners-up,
// and fix the weaknesses the judges flagged.
const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "rationale", "steps", "filesToChange", "testsToAdd", "verificationPlan", "outOfScope"],
  properties: {
    title: { type: "string" },
    rationale: { type: "string", description: "why this plan, and which grafted ideas from runners-up were folded in" },
    steps: { type: "array", items: { type: "string" }, description: "ordered, concrete implementation steps" },
    filesToChange: { type: "array", items: { type: "string" } },
    testsToAdd: { type: "array", items: { type: "string" }, description: "each test names what it asserts and which acceptance criterion it covers" },
    verificationPlan: { type: "array", items: { type: "string" }, description: "how to prove each acceptance criterion is met, including the exact test command" },
    outOfScope: { type: "array", items: { type: "string" }, description: "explicit non-goals carried forward to keep the change scoped" },
  },
};

const plan = await agent(
  `Synthesize the FINAL implementation plan. Start from the winning approach, graft in the best ideas from the runners-up, and resolve the weaknesses the judges flagged. Keep it tightly scoped to the ticket.\n\n` +
    `${sharedContext}\n\n` +
    `WINNING APPROACH (score ${winner.score.toFixed(2)}):\n${JSON.stringify(winner.approach, null, 2)}\n\n` +
    `JUDGE NOTES ON WINNER:\n${winner.judges.map((j) => `- best: ${j.bestIdea} | weakness: ${j.weakness}`).join("\n")}\n\n` +
    `RUNNER-UP IDEAS WORTH GRAFTING:\n${runnersUp
      .map((r) => `- (${r.approach.style}, score ${r.score.toFixed(2)}) best ideas: ${r.judges.map((j) => j.bestIdea).join("; ")}`)
      .join("\n") || "(none)"}\n\n` +
    `Output a single, coherent plan with ordered steps, concrete files and tests (each tied to an acceptance criterion), and a verification plan that uses the test command "${testCommand}".`,
  { label: "synthesize-plan", phase: "Plan", schema: planSchema, effort: "high", allowFailure: true },
);

if (!plan) {
  log("Plan synthesis failed; falling back to the top-scored raw approach.");
}
const finalPlan = plan || {
  title: winner.approach.summary,
  rationale: `Synthesis step unavailable; using top-scored ${winner.approach.style} approach directly.`,
  steps: winner.approach.steps,
  filesToChange: winner.approach.filesToChange,
  testsToAdd: winner.approach.testsToAdd,
  verificationPlan: [`Run ${testCommand} and confirm all acceptance criteria are exercised.`],
  outOfScope: ticket.outOfScope || [],
};

// ===========================================================================
// PHASE 3 — IMPLEMENT (in an isolated worktree so main checkout stays clean)
// ===========================================================================
phase("Implement");
log(`Implementing "${finalPlan.title}" in an isolated worktree.`);

const implementRun = await agent(
  `Implement the plan below. You are running in a FRESH ISOLATED GIT CLONE — make all changes here; do not touch the main checkout.\n\n` +
    `${sharedContext}\n\n` +
    `FINAL PLAN:\n${JSON.stringify(finalPlan, null, 2)}\n\n` +
    `Rules:\n` +
    `- Write the code AND the tests. Each acceptance criterion must be covered by a test where feasible.\n` +
    `- Follow the repo conventions captured in the code map. Mirror existing test style and location.\n` +
    `- Stay strictly within scope. Do NOT do anything in OUT OF SCOPE. No drive-by refactors.\n` +
    `- Run the test command: ${testCommand}. If failures are caused by your change, fix them and re-run until green (or until you are confident a remaining failure is pre-existing and unrelated — say so explicitly).\n` +
    `- Do NOT commit, push, or open a PR — the Ship phase handles that after the change is reviewed.\n\n` +
    jsonContract(
      `filesChanged (string[]), testsAdded (string[]), testCommandRun (string, the exact command you ran), ` +
        `testsPassed (boolean), testOutputTail (string), summary (string: what you implemented and how it satisfies the acceptance criteria)`,
    ) +
    `\nDo NOT try to report the worktree path or diff path yourself — the orchestrator derives those from the run.`,
  { label: "implement", phase: "Implement", isolation: "worktree", effort: "high", returnMetadata: true, network: true, allowFailure: true },
);
const implementText = implementRun && typeof implementRun.value === "string" ? implementRun.value : "";

if (!implementText) {
  log("Implementation agent failed.");
  return {
    plan: finalPlan,
    worktree: null,
    testResult: { command: testCommand, passed: false, outputTail: "implementation agent did not return a result" },
    reviewVerdict: "blocked",
    summary: "The implementation step failed to produce changes. The plan is sound but no code was written. Re-run, or implement manually from the returned plan.",
  };
}

const implReport = extractJsonBlock(implementText) || {};
const implementation = {
  filesChanged: Array.isArray(implReport.filesChanged) ? implReport.filesChanged : [],
  testsAdded: Array.isArray(implReport.testsAdded) ? implReport.testsAdded : [],
  testCommandRun: typeof implReport.testCommandRun === "string" ? implReport.testCommandRun : testCommand,
  testsPassed: implReport.testsPassed === true,
  testOutputTail: typeof implReport.testOutputTail === "string" ? implReport.testOutputTail : "(no test output captured)",
  worktreePath: implementRun.workspacePath,
  diffPath: implementRun.diffPath,
  summary: typeof implReport.summary === "string" ? implReport.summary : "(no summary returned)",
  rawText: implementText.slice(0, 4000),
};

// If the worktree note is absent, the implementer made no file changes — that is a
// real failure for an implementation task (nothing to review or hand back).
if (!implementation.worktreePath) {
  log("Implementation produced no worktree changes (no preservation note).");
  return {
    plan: finalPlan,
    worktree: null,
    testResult: { command: implementation.testCommandRun, passed: false, outputTail: implementation.testOutputTail },
    reviewVerdict: "blocked",
    summary:
      "The implementation step ran but left no changes in the worktree (no files were written). " +
      "The plan is sound; re-run or implement manually from the returned plan.\n\nImplementer report: " +
      implementation.summary,
  };
}

log(
  `Implementation done. Tests ${implementation.testsPassed ? "passed" : "did NOT pass"} via "${implementation.testCommandRun}". ` +
    `Worktree: ${implementation.worktreePath}.`,
);

// ===========================================================================
// PHASE 4 — REVIEW (adversarial: independent reviewers try to REFUTE the work)
// ===========================================================================
phase("Review");

const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["lens", "verdict", "issues"],
  properties: {
    lens: { type: "string" },
    verdict: { type: "string", enum: ["pass", "concerns", "fail"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "claim", "evidence", "fix"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          claim: { type: "string", description: "the specific real problem (not a style nit)" },
          evidence: { type: "string", description: "file:line or observed test/command output proving it — must be verifiable, not speculation" },
          fix: { type: "string", description: "the minimal change that resolves it" },
        },
      },
    },
  },
};

const reviewLenses = [
  {
    key: "correctness",
    brief:
      "CORRECTNESS: does the code actually satisfy EVERY acceptance criterion? Look for logic errors, unhandled edge cases, and criteria that are claimed-but-not-met. Re-run the test command yourself to confirm the claimed result.",
  },
  {
    key: "test-adequacy",
    brief:
      "TEST-ADEQUACY: do the tests genuinely prove the criteria, or are they shallow/tautological? Check for missing edge cases, tests that would pass even if the feature were broken, and uncovered acceptance criteria. Re-run the tests.",
  },
  {
    key: "regression-risk",
    brief:
      "REGRESSION-RISK: could this break existing behavior or integration points? Look at the full diff for out-of-scope edits, broken contracts, and changes to shared code. Re-run the FULL test suite, not just the new tests.",
  },
];

// Each reviewer receives the implementation diff in its own fresh writable clone.
const reviewWorktreeNote =
  `The implementation diff has already been applied to your current isolated clone. ` +
  `Inspect it with \`git diff HEAD\` / \`git status\` and run the tests in your current working directory with \`${testCommand}\`. ` +
  `Do not access or mutate another agent's workspace.`;

const reviews = (
  await parallel(
    reviewLenses.map((lens) => () =>
      agent(
        `You are an adversarial reviewer. Your job is to REFUTE the claim that this change is correct and complete, through the ${lens.brief}\n\n` +
          `Only report problems you can back with concrete evidence (a file:line or actual command/test output). Do not invent issues; if it is solid, say so. Re-run "${testCommand}" yourself in the worktree rather than trusting the implementer's claim.\n\n` +
          `${sharedContext}\n\n` +
          `IMPLEMENTATION REPORT:\n${JSON.stringify(
            {
              filesChanged: implementation.filesChanged,
              testsAdded: implementation.testsAdded,
              testCommandRun: implementation.testCommandRun,
              testsPassed: implementation.testsPassed,
              testOutputTail: implementation.testOutputTail,
              summary: implementation.summary,
            },
            null,
            2,
          )}\n\n` +
          `${reviewWorktreeNote}`,
        { label: `review-${lens.key}`, phase: "Review", schema: reviewSchema, effort: "high", patches: [implementation.diffPath], network: true },
      ),
    ),
  )
).filter(Boolean);

// Collect only evidence-backed blocker/major issues — these are the ones that survived
// an adversarial pass and are worth a fix.
const realIssues = [];
for (const r of reviews) {
  for (const issue of r.issues || []) {
    if (issue.severity === "blocker" || issue.severity === "major") realIssues.push({ lens: r.lens, ...issue });
  }
}
const anyFailVerdict = reviews.some((r) => r.verdict === "fail");
log(`Review complete. Reviewers: ${reviews.length}. Evidence-backed blocker/major issues: ${realIssues.length}.`);

// The active worktree/diff handed back to the user. It moves to the fix-pass worktree
// if (and only if) the fix pass actually preserved changes.
let activeWorktreePath = implementation.worktreePath;
let activeDiffPath = implementation.diffPath;
let fixResult = null;
let postFixTestsPassed = implementation.testsPassed;
let postFixTestTail = implementation.testOutputTail;

if (realIssues.length > 0 || anyFailVerdict || !implementation.testsPassed) {
  log(`Running one bounded fix pass for ${realIssues.length} issue(s).`);
  // The fix pass runs in its OWN fresh clone seeded with the preserved implementation diff.
  const fixRun = await agent(
    `Do ONE bounded fix pass for the change described below. You are in a FRESH isolated clone and the prior implementation diff has already been applied. Address the issues on top of those changes. ` +
      `Do NOT expand scope, refactor unrelated code, or start new features. If an issue is out of scope or a false positive, leave it and explain in remainingIssues.\n\n` +
      `${sharedContext}\n\n` +
      `ORIGINAL IMPLEMENTATION REPORT:\n${JSON.stringify(
        {
          filesChanged: implementation.filesChanged,
          testsAdded: implementation.testsAdded,
          summary: implementation.summary,
        },
        null,
        2,
      )}\n` +
      `Seeded implementation diff: ${implementation.diffPath}\n\n` +
      `ISSUES TO ADDRESS (only blockers/majors with evidence):\n${
        realIssues
          .map((i, n) => `${n + 1}. [${i.severity}/${i.lens}] ${i.claim}\n   evidence: ${i.evidence}\n   suggested fix: ${i.fix}`)
          .join("\n") || "(no specific issues, but tests were not green — get them green)"
      }\n\n` +
      `After fixing, re-run "${testCommand}".\n\n` +
      jsonContract(
        `fixedIssues (string[]), remainingIssues (string[]: issues you could NOT fix within scope, with why), ` +
          `testCommandRun (string), testsPassed (boolean), testOutputTail (string), summary (string)`,
      ),
    { label: "fix-pass", phase: "Review", isolation: "worktree", effort: "high", patches: [implementation.diffPath], returnMetadata: true, network: true, allowFailure: true },
  );
  const fixText = fixRun && typeof fixRun.value === "string" ? fixRun.value : "";

  if (fixText) {
    const fixReport = extractJsonBlock(fixText) || {};
    fixResult = {
      fixedIssues: Array.isArray(fixReport.fixedIssues) ? fixReport.fixedIssues : [],
      remainingIssues: Array.isArray(fixReport.remainingIssues) ? fixReport.remainingIssues : [],
      testCommandRun: typeof fixReport.testCommandRun === "string" ? fixReport.testCommandRun : testCommand,
      testsPassed: fixReport.testsPassed === true,
      testOutputTail: typeof fixReport.testOutputTail === "string" ? fixReport.testOutputTail : "(no test output captured)",
      summary: typeof fixReport.summary === "string" ? fixReport.summary : "(no summary returned)",
      worktreePath: fixRun.workspacePath,
      diffPath: fixRun.diffPath,
    };
    postFixTestsPassed = fixResult.testsPassed;
    postFixTestTail = fixResult.testOutputTail;
    // Only switch the handed-back worktree if the fix pass actually preserved changes;
    // otherwise the implement worktree remains the source of truth.
    if (fixResult.worktreePath) {
      activeWorktreePath = fixResult.worktreePath;
      activeDiffPath = fixResult.diffPath;
    }
    log(`Fix pass done. Tests now ${fixResult.testsPassed ? "pass" : "still failing"}. Active worktree: ${activeWorktreePath}.`);
  } else {
    log("Fix pass agent failed to return a result; leaving original implementation worktree in place.");
  }
}

// A fix report is not self-verifying. Re-review the complete fixed diff independently and
// derive shipping blockers from that result rather than blindly retaining or clearing the
// original findings.
let postFixReview = null;
let finalReviewIssues = realIssues;
let finalFailVerdict = anyFailVerdict;
if (fixResult && activeDiffPath) {
  postFixReview = await agent(
    `Independently verify the COMPLETE post-fix change already seeded into your current isolated clone. Re-run "${testCommand}". Adjudicate every original finding and every item the fixer says remains; report only blocker/major problems that still exist with concrete file:line or command evidence. If all earlier issues are truly fixed and tests pass, return pass with no issues.\n\n` +
      `${sharedContext}\n\n` +
      `ORIGINAL FINDINGS:\n${JSON.stringify(realIssues, null, 2)}\n\n` +
      `FIX REPORT:\n${JSON.stringify(fixResult, null, 2)}`,
    { label: "post-fix-review", phase: "Review", schema: reviewSchema, effort: "high", patches: [activeDiffPath], network: true },
  );
  if (postFixReview) {
    finalReviewIssues = (postFixReview.issues || []).filter((issue) => issue.severity === "blocker" || issue.severity === "major");
    finalFailVerdict = postFixReview.verdict === "fail";
  } else {
    finalReviewIssues = [{
      lens: "post-fix",
      severity: "major",
      claim: "Post-fix verification did not complete.",
      evidence: "The independent post-fix reviewer returned no validated result.",
      fix: "Re-run independent verification before shipping.",
    }];
    finalFailVerdict = true;
  }
}

const survivingBlockers = finalReviewIssues.filter((issue) => issue.severity === "blocker");
const survivingMajors = finalReviewIssues.filter((issue) => issue.severity === "major");
const blockingFindings = [...survivingBlockers, ...survivingMajors];
const reviewVerdict = postFixTestsPassed && blockingFindings.length === 0 && !finalFailVerdict
  ? fixResult ? "pass-after-fix" : "pass"
  : blockingFindings.length > 0 || finalFailVerdict
    ? "needs-attention"
    : "tests-failing";

// ===========================================================================
// PHASE 5 — SHIP (commit on a well-named branch, push, open a well-described PR)
// ===========================================================================
const toSlug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
// Branch/base names are AGENT/EXTERNAL-supplied (triage output, ticket ids) and get
// interpolated into the git/gh commands the Ship agent runs. Validate them against a
// strict git-ref pattern so they cannot carry shell metacharacters, path traversal,
// or option injection — anything that fails is dropped in favour of a safe generated name.
const PROTECTED = /^(main|master|develop|development|production|prod|release|releases|staging|trunk)$/i;
const safeRef = (name) => {
  const n = String(name || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(n) && !n.includes("..") ? n : "";
};
const baseBranch = safeRef(triageInfo.baseBranch) || "main";
const generatedBranch = `${ticket.id && toSlug(ticket.id) ? `${toSlug(ticket.id)}-` : "ticket-"}${toSlug(finalPlan.title) || "change"}`;
let branchName = safeRef(triageInfo.existingBranch) || safeRef(triageInfo.branchName) || generatedBranch;
// Never push directly to a protected branch or the PR base — always a feature branch.
// (guardrails blocks force-push to protected branches, but not a plain push, so this
//  guard is the workflow's own safety floor.)
if (PROTECTED.test(branchName) || branchName === baseBranch) {
  log(`Refusing to push to protected/base branch "${branchName}"; using feature branch "${generatedBranch}".`);
  branchName = generatedBranch;
  triageInfo.existingBranch = "";
  triageInfo.existingPr = "";
}

// Only ship if the change is sound AND the branch is a safe, non-protected feature branch.
const shippable =
  Boolean(activeWorktreePath) &&
  Boolean(activeDiffPath) &&
  postFixTestsPassed &&
  blockingFindings.length === 0 &&
  !finalFailVerdict &&
  Boolean(safeRef(branchName)) &&
  !PROTECTED.test(branchName) &&
  branchName !== baseBranch;
let pr = null;

if (optedOutOfPr) {
  log("Opted out of a PR — leaving the change in the worktree.");
} else if (!shippable) {
  log(`Not shipping: ${!activeWorktreePath ? "no workspace" : blockingFindings.length ? "surviving blocker/major findings" : finalFailVerdict ? "review verification failed" : "tests failing"} — left in the workspace.`);
} else {
  phase("Ship");
  log(`Shipping branch ${branchName} -> PR against ${baseBranch}.`);
  const acChecklist = (ticket.acceptanceCriteria || []).map((c) => `- [ ] ${c}`).join("\n") || "- [ ] (see description)";
  const shipSchema = {
    type: "object",
    additionalProperties: false,
    required: ["pushed", "branch", "prUrl", "conflict", "notes"],
    properties: {
      pushed: { type: "boolean" },
      branch: { type: "string" },
      prUrl: { type: "string", description: "the PR URL (new, or the existing one updated), empty if none was opened" },
      prNumber: { type: "string" },
      conflict: { type: "boolean", description: "true if the change could not be applied cleanly onto an existing branch" },
      notes: { type: "string" },
    },
  };
  pr = await agent(
    `Open the implemented + reviewed change as a PR. The reviewed diff has already been applied to your current isolated clone; operate only in this clone.\n\n` +
      `Base branch: ${baseBranch}. Branch to use: ${branchName}.\n` +
      `SAFETY: push ONLY the branch "${branchName}". NEVER push to "${baseBranch}" or any protected branch (main/master/develop/production), never force-push, and never run any command other than the git/gh steps below.\n` +
      (triageInfo.existingBranch
        ? `This CONTINUES existing work on ${triageInfo.existingBranch}${triageInfo.existingPr ? ` (PR ${triageInfo.existingPr})` : ""}: bring your changes onto that branch (fetch it, then cherry-pick/apply your commit onto it) and push it, updating its PR rather than opening a duplicate. If the changes do not apply cleanly, set conflict:true, push nothing, and explain in notes.\n`
        : "") +
      `Steps:\n` +
      `0. Run \`gh auth setup-git\`. If origin is an SSH GitHub URL but this sandbox has no SSH key, replace it with the equivalent HTTPS GitHub URL; use only the provided ephemeral GitHub auth.\n` +
      `1. In your current clone, stage and commit ALL changes with a clear conventional message derived from the ticket (e.g. "<type>: <title>${ticket.id ? ` (${ticket.id})` : ""}"). Put the commit on branch ${branchName} (create it at the current commit if you are not already on it).\n` +
      `2. Push: \`git push -u origin ${branchName}\`.\n` +
      (triageInfo.existingPr
        ? `3. A PR already exists (${triageInfo.existingPr}); do NOT open another — pushing updates it. Report that URL.\n`
        : `3. Open a PR: \`gh pr create --base ${baseBranch} --head ${branchName}${draftPr ? " --draft" : ""} --title "<concise title>" --body-file <a temp .md file>\`. Write the body to a temp file first to avoid shell-escaping issues.\n`) +
      `   The PR body MUST be well-described, with these sections:\n` +
      `   ## Summary — what changed and why (1-3 sentences).\n` +
      `   ## Changes — bullet list of the notable changes.\n` +
      `   ## Testing — \`${testCommand}\` and that it passes.\n` +
      `   ## Acceptance criteria\n${acChecklist}\n` +
      (ticket.id ? `   Reference the ticket (${ticket.id}).\n` : "") +
      (triageInfo.tooBigForOnePr ? `   Note that this is the first slice of a larger ticket; follow-up PRs: ${(triageInfo.suggestedSubtasks || []).join("; ")}.\n` : "") +
      `4. Do NOT merge the PR. Report the PR URL, the branch, whether you pushed, and conflict:true if it could not be applied onto the existing branch.`,
    { label: "ship-pr", phase: "Ship", schema: shipSchema, effort: "high", agentType: "worker", patches: [activeDiffPath], network: true, githubAuth: true },
  );
  if (pr && pr.prUrl) log(`PR ready: ${pr.prUrl}`);
  else log("Ship step returned no PR URL; the change remains in the worktree.");
}

const shipNote = optedOutOfPr
  ? `Opted out of a PR — the change is in the worktree${activeWorktreePath ? ` at ${activeWorktreePath}` : ""} for you to review/merge.`
  : pr && pr.prUrl
    ? `PR: ${pr.prUrl}${pr.conflict ? " (changes could not be cleanly applied onto the existing branch — resolve the conflict)" : ""}`
    : `No PR opened (${blockingFindings.length ? "surviving blocker/major findings" : finalFailVerdict ? "review verification failed" : !postFixTestsPassed ? "tests failing" : "ship step incomplete"}); the change is in the workspace${activeWorktreePath ? ` at ${activeWorktreePath}` : ""}.`;
const relatedNote = (triageInfo.relatedIssues || []).length ? `\nRelated/duplicate issues: ${triageInfo.relatedIssues.join("; ")}` : "";
const breakdownNote = triageInfo.tooBigForOnePr
  ? `\nLarge ticket — this run shipped the first slice; recommended follow-up PRs: ${(triageInfo.suggestedSubtasks || []).join("; ") || "(see triage)"}.`
  : "";

const summary =
  `Ticket: ${ticket.id ? `${ticket.id} — ` : ""}${ticket.title}\n` +
  `Plan: ${finalPlan.title}\n` +
  `Implementation: ${implementation.filesChanged.length} file(s) changed, ${implementation.testsAdded.length} test(s) added.\n` +
  `Tests: ${postFixTestsPassed ? "PASSING" : "FAILING"} via "${fixResult ? fixResult.testCommandRun : implementation.testCommandRun}".\n` +
  `Review: ${reviews.length} initial adversarial reviewer(s)${postFixReview ? " plus independent post-fix verification" : ""}; ${realIssues.length} initial blocker/major issue(s)` +
  `${fixResult ? `, ${fixResult.fixedIssues.length} addressed in one bounded pass` : ""}. Verdict: ${reviewVerdict}.\n` +
  (blockingFindings.length > 0 ? `Surviving blocker/major findings: ${blockingFindings.map((finding) => finding.claim).join("; ")}\n` : "") +
  shipNote + relatedNote + breakdownNote;

return {
  triage: triageInfo,
  plan: finalPlan,
  worktree: {
    path: activeWorktreePath,
    diffPath: activeDiffPath,
    implementWorktree: implementation.worktreePath,
    fixWorktree: fixResult ? fixResult.worktreePath : null,
    branch: pr ? pr.branch : null,
  },
  testResult: {
    command: fixResult ? fixResult.testCommandRun : implementation.testCommandRun,
    passed: postFixTestsPassed,
    outputTail: postFixTestTail,
  },
  reviewVerdict,
  reviews,
  fixPass: fixResult,
  postFixReview,
  pr: pr ? { url: pr.prUrl, branch: pr.branch, pushed: pr.pushed, conflict: pr.conflict } : null,
  summary,
};
