export const meta = {
  version: 2,
  name: "review-pr",
  description:
    "Review a GitHub PR across six independent dimensions (correctness, security, architecture, test coverage, ticket/AC compliance, style), adversarially verify every finding, then synthesise one prioritised report. args is the PR number or { pr, post }.",
  phases: [
    { title: "Context", detail: "Fetch PR metadata, exact base...head diff, prior discussion; build the shared changed-file list and compact diff summary." },
    { title: "Review", detail: "One reviewer agent per dimension returns structured findings (file, line, severity, description, fix)." },
    { title: "Verify", detail: "An independent skeptic adjudicates each finding REAL vs not-real; keep only confirmed findings." },
    { title: "Synthesize", detail: "Dedup confirmed findings, prioritise by severity, produce one report; note posting if args.post." },
  ],
};

// ---- Resolve args: a bare PR number, or { pr, post } -------------------------
const rawPr =
  args && typeof args === "object" ? args.pr : args;
const prNumber = String(rawPr == null ? "" : rawPr).trim().replace(/^#/, "");
const shouldPost = !!(args && typeof args === "object" && args.post);

if (!prNumber || !/^\d+$/.test(prNumber)) {
  return {
    confirmedFindings: [],
    report:
      "review-pr: no valid PR number supplied. Pass the PR number directly (e.g. 4811) or { pr: 4811, post: true }.",
  };
}

log("Reviewing PR #" + prNumber + (shouldPost ? " (post mode)" : " (report only)"));

// ---- Schemas for structured hand-offs ---------------------------------------
const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "confidence", "file", "lines", "title", "what", "why", "fix", "dimension"],
  properties: {
    severity: { type: "string", enum: ["CRITICAL", "SHOULD_FIX", "SUGGESTION"] },
    confidence: { type: "integer", minimum: 80, maximum: 100 },
    file: { type: "string" },
    lines: { type: "string", description: "Line or range in the changed file, e.g. 42-45" },
    title: { type: "string" },
    what: { type: "string" },
    why: { type: "string" },
    fix: { type: "string" },
    dimension: { type: "string" },
  },
};

const reviewResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["dimension", "filesReviewed", "findings"],
  properties: {
    dimension: { type: "string" },
    filesReviewed: { type: "array", items: { type: "string" } },
    findings: { type: "array", items: findingSchema },
  },
};

const contextSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "baseOid", "headOid", "baseRef", "headRef", "title", "changedFiles", "diffSummary", "priorDiscussion", "ticket"],
  properties: {
    ok: { type: "boolean", description: "false if the PR/diff could not be fetched" },
    error: { type: "string" },
    baseOid: { type: "string" },
    headOid: { type: "string" },
    baseRef: { type: "string" },
    headRef: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    changedFiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "category", "additions", "deletions"],
        properties: {
          path: { type: "string" },
          category: { type: "string" },
          additions: { type: "integer" },
          deletions: { type: "integer" },
        },
      },
    },
    diffSummary: { type: "string", description: "Compact per-file summary of what changed; reviewers share this." },
    priorDiscussion: { type: "string", description: "Compact prior review threads tagged RESOLVED/OUTDATED/OPEN, or 'none'." },
    ticket: {
      type: "object",
      additionalProperties: false,
      required: ["id", "found", "summary"],
      properties: {
        id: { type: "string" },
        found: { type: "boolean" },
        summary: { type: "string", description: "Ticket title + acceptance criteria if retrievable, else why not." },
      },
    },
  },
};

const verdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["real", "confidence", "reasoning", "adjustedSeverity"],
  properties: {
    real: { type: "boolean" },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    reasoning: { type: "string" },
    adjustedSeverity: { type: "string", enum: ["CRITICAL", "SHOULD_FIX", "SUGGESTION", "DROP"] },
  },
};

// =============================================================================
// Phase 1 — Context (single agent owns gh/git so reviewers share one ground truth)
// =============================================================================
phase("Context");

const sharedContext = `You are gathering review context for GitHub PR #${prNumber}. Use ONLY read-only commands; do NOT edit files, push, or post anything.

Steps (run with gh/git/jq in bash):
1. Fetch metadata: gh pr view ${prNumber} --json number,title,body,baseRefName,baseRefOid,headRefName,headRefOid,url
2. Resolve the EXACT diff range baseRefOid...headRefOid (fetch refs first if needed: git fetch origin <baseRef> <headRef>). Prefer the SHA range over branch names so already-merged commits are excluded.
3. Build the changed-file list with per-file additions/deletions (git diff --numstat BASE_OID...HEAD_OID, or gh pr diff). Categorise each file as one of: frontend, backend, database, infrastructure, packages, tests, config, docs.
4. Produce a COMPACT diff summary: for each changed file, 1-3 lines describing what actually changed (new functions, changed signatures, removed guards, new branches). This is the shared map reviewers rely on — be faithful to the real diff, do not invent.
5. Fetch prior review discussion: gh pr view ${prNumber} --comments and the review threads (gh api repos/{owner}/{repo}/pulls/${prNumber}/comments). Summarise each thread compactly and TAG it [RESOLVED], [OUTDATED], or [OPEN] with its file:line. If none, set priorDiscussion to "none".
6. Extract a ticket id from the branch name or PR body (pattern: alphanumeric prefix + number, e.g. PROJ-1234). If found, try to retrieve its title and acceptance criteria via available CLIs (linear-cli, jira, gh issue). Put a compact summary in ticket.summary; set found accordingly. If no ticket, id="" and found=false.

If the PR cannot be fetched (no such PR, auth failure, empty diff), set ok=false and explain in error; leave the other fields as best-effort empties.
Return faithful, grounded data only.`;

const ctx = await agent(sharedContext, {
  label: "context",
  phase: "Context",
  schema: contextSchema,
  agentType: "scout",
  effort: "medium",
  network: true,
  githubAuth: true,
});

if (!ctx || ctx.ok === false || !ctx.changedFiles || ctx.changedFiles.length === 0) {
  const reason = ctx && ctx.error ? ctx.error : "PR context could not be gathered or the diff was empty.";
  log("Context gathering failed: " + reason);
  return {
    confirmedFindings: [],
    report: "# Review of PR #" + prNumber + "\n\nCould not review: " + reason,
  };
}

log("Context ready: " + ctx.changedFiles.length + " changed files; ticket " + (ctx.ticket && ctx.ticket.found ? ctx.ticket.id : "none"));

// Compact, serialisable context shared verbatim with every reviewer.
const changedFileList = ctx.changedFiles
  .map((f) => "- " + f.path + " (" + f.category + ", +" + f.additions + "/-" + f.deletions + ")")
  .join("\n");

const sharedBrief = [
  "PR #" + prNumber + ": " + (ctx.title || "(no title)"),
  "Diff range (exact): " + ctx.baseOid + "..." + ctx.headOid + "  (" + ctx.baseRef + " <- " + ctx.headRef + ")",
  "",
  "## Changed files (" + ctx.changedFiles.length + ")",
  changedFileList,
  "",
  "## Compact diff summary",
  ctx.diffSummary || "(none provided)",
  "",
  "## Prior review discussion",
  ctx.priorDiscussion || "none",
  "",
  "## Ticket",
  ctx.ticket && ctx.ticket.found
    ? ctx.ticket.id + ": " + ctx.ticket.summary
    : "No ticket retrieved.",
].join("\n");

// =============================================================================
// Phase 2 + 3 — Review (one agent per dimension) then adversarial Verify.
// Pipeline: each dimension's findings flow straight into verification with no
// barrier, so verifying dimension A overlaps reviewing dimension B.
//
// Phase markers are emitted ONCE here, at top level, in run order. Review and
// Verify genuinely overlap (the pipeline has no barrier), so we do NOT call
// phase() from inside the concurrent stages — doing so would push duplicate,
// out-of-order phase records from racing branches and scramble the progress
// widget. Each agent still carries an explicit `phase:` opt, which is what the
// runtime groups progress by, so attribution stays exact.
// =============================================================================
phase("Review");
phase("Verify");

// Reuse the six proven pr-review dimensions.
const dimensions = [
  {
    key: "correctness",
    title: "Correctness and bugs",
    focus:
      "Logic errors, off-by-one, null/undefined dereferences, incorrect error handling, race conditions, broken control flow, regressions, removed guards/fallbacks. Trace each suspect path to confirm it is actually reachable before flagging.",
  },
  {
    key: "security",
    title: "Security",
    focus:
      "Hardcoded secrets/tokens, injection (SQL/command/XSS/template), missing authN/authZ checks, broken access-control predicates, input validation gaps at system boundaries, insecure dependencies or patterns, sensitive data exposure. Security findings default to CRITICAL.",
  },
  {
    key: "architecture",
    title: "Architecture and design",
    focus:
      "Whether the approach is sound for the goal; duplicated functionality (search for an existing utility before flagging); unclear boundaries; error-handling, service-communication and data-access patterns. Only flag deviations that cause real confusion or bugs, not stylistic differences.",
  },
  {
    key: "tests",
    title: "Test coverage",
    focus:
      "Whether tests give real confidence in this change. Missing negative tests for important failure modes (not trivial guards), brittle tests coupled to implementation, and false-confidence tests (assertions that always pass). Ask for tests ONLY for security/authz, data-loss, subtle correctness primitives, or false-confidence repair.",
  },
  {
    key: "ticket",
    title: "Ticket and AC compliance",
    focus:
      "Coverage of every ticket requirement and acceptance criterion; partially-implemented requirements; missing edge cases the ticket names; scope creep (mark as SUGGESTION). Only run a real assessment if a ticket was retrieved; if none, return zero findings.",
  },
  {
    key: "style",
    title: "Style and convention adherence",
    focus:
      "Deviations from project conventions (naming, imports, file structure, British English, type-vs-interface, no stray any casts) that cause real confusion or maintenance burden. Only flag changed lines, never pre-existing code. Most of these are SUGGESTION at most.",
  },
];

const reviewedDimensions = await pipeline(
  dimensions,

  // --- Stage 1: review one dimension, return structured findings ---
  async (dimension) => {
    const prompt = `You are an expert PR reviewer focused on ONE dimension: ${dimension.title}.

Dimension focus: ${dimension.focus}

You are reviewing GitHub PR #${prNumber}. Work in read-only mode (read, grep, git show, gh) — do NOT edit, push, or post.
To inspect the real changes, read the exact diff with: git diff ${ctx.baseOid}...${ctx.headOid} (or per file). You MAY read surrounding/unchanged code via 'git show ${ctx.headOid}:path' to verify a finding, but only flag issues the PR creates or worsens.

Shared context for all reviewers:
${sharedBrief}

Mindset: the expected answer is that this PR is fine — most are. You are looking for genuine blockers and genuinely useful improvements, not reasons to criticise. A false high-severity finding is worse than a missed suggestion.

Severity rules:
- CRITICAL (confidence 90-100): must fix before merge. Read the full surrounding function and confirm no existing guard/fallback/handler already addresses it; trace any "X could happen" path to confirm reachability.
- SHOULD_FIX (confidence 80-89): real production problem, correctness risk, or meaningful confusion.
- SUGGESTION: things the author would genuinely thank you for. Max 3.
Report ONLY findings with confidence >= 80. Do NOT manufacture findings — an empty findings array is a good outcome.

Respect prior discussion: if a thread is tagged [RESOLVED] or an [OPEN] thread shows the author addressed it and the reviewer accepted, do NOT re-raise. For an [OPEN] thread with the author's reasoning unanswered, at most restate as a SUGGESTION noting the open thread.

For every finding, set dimension to "${dimension.key}". Use the changed file's path in 'file' and a precise line/range in 'lines'.`;

    const result = await agent(prompt, {
      label: "review-" + dimension.key,
      phase: "Review",
      schema: reviewResultSchema,
      agentType: "reviewer",
      effort: "high",
      network: true,
      githubAuth: true,
    });

    if (!result) {
      log("Reviewer for " + dimension.key + " produced no result.");
      return { dimension, findings: [] };
    }
    const findings = Array.isArray(result.findings) ? result.findings : [];
    log(dimension.key + ": " + findings.length + " candidate finding(s)");
    return { dimension, findings };
  },

  // --- Stage 2: adversarial verification of THIS dimension's findings ---
  // Independent skeptics, one per finding, default to not-real if speculative
  // or already handled. No barrier: verification for dimension A overlaps
  // reviewing dimension B. (Phase markers are NOT emitted here — see note above.)
  async (reviewed) => {
    const findings = reviewed.findings || [];
    if (findings.length === 0) return { dimension: reviewed.dimension, confirmed: [] };

    const verdicts = await parallel(
      findings.map((finding, i) => async () => {
        const verifyPrompt = `You are an INDEPENDENT skeptic verifying a single PR-review finding. Your default is NOT-REAL: confirm a finding as REAL only if you can independently reproduce the problem in the actual code.

PR #${prNumber}. Inspect the real code read-only: read the exact diff with 'git diff ${ctx.baseOid}...${ctx.headOid}', and read surrounding/unchanged code with 'git show ${ctx.headOid}:path' to check for existing guards, fallbacks, validation, or handlers. Do NOT edit or post.

Shared context:
${sharedBrief}

Finding under scrutiny (dimension: ${finding.dimension}, claimed severity ${finding.severity}, confidence ${finding.confidence}):
- file: ${finding.file}
- lines: ${finding.lines}
- title: ${finding.title}
- what: ${finding.what}
- why: ${finding.why}
- proposed fix: ${finding.fix}

Reject (real=false / adjustedSeverity DROP) when ANY of these hold:
- The concern is speculative or needs multiple unlikely conditions to manifest.
- An existing guard, fallback, validation, try/catch, or type already handles it.
- The cited code path is not actually reachable.
- It targets pre-existing/unchanged code the PR does not worsen.
- A prior discussion thread already resolved it.
- It is a pure style preference with no real impact (downgrade rather than confirm as a blocker).

If REAL, set real=true and adjustedSeverity to the severity the EVIDENCE supports (you may downgrade a claimed CRITICAL to SHOULD_FIX/SUGGESTION). Justify with specific evidence (file:line, the guard you did or did not find). When genuinely uncertain after checking, default to real=false.`;

        const verdict = await agent(verifyPrompt, {
          label: "verify-" + reviewed.dimension.key + "-" + (i + 1),
          phase: "Verify",
          schema: verdictSchema,
          agentType: "oracle",
          effort: "high",
          network: true,
          githubAuth: true,
        });
        return { finding, verdict };
      }),
    );

    const confirmed = verdicts
      .filter(Boolean)
      .filter((v) => v.verdict && v.verdict.real === true && v.verdict.adjustedSeverity !== "DROP")
      .map((v) => ({
        severity: v.verdict.adjustedSeverity || v.finding.severity,
        confidence: v.finding.confidence,
        file: v.finding.file,
        lines: v.finding.lines,
        title: v.finding.title,
        what: v.finding.what,
        why: v.finding.why,
        fix: v.finding.fix,
        dimension: v.finding.dimension,
        verifierReasoning: v.verdict.reasoning,
      }));

    log(
      reviewed.dimension.key +
        ": " +
        confirmed.length +
        " of " +
        findings.length +
        " finding(s) survived verification",
    );
    return { dimension: reviewed.dimension, confirmed };
  },
);

// =============================================================================
// Phase 4 — Synthesize. BARRIER: dedup needs every confirmed finding together.
// =============================================================================
phase("Synthesize");

const allConfirmed = (reviewedDimensions || [])
  .filter(Boolean)
  .flatMap((d) => (d && Array.isArray(d.confirmed) ? d.confirmed : []));

if (allConfirmed.length === 0) {
  const cleanReport =
    "# Review of PR #" +
    prNumber +
    ": " +
    (ctx.title || "") +
    "\n\n**Verdict: APPROVE**\n\nReviewed across six dimensions (correctness, security, architecture, tests, ticket/AC, style); every candidate finding was adjudicated by an independent skeptic and none survived. No blocking issues found.\n\n## Files reviewed\n" +
    changedFileList +
    (shouldPost
      ? "\n\n---\n_Post mode requested: would post an APPROVE review to PR #" +
        prNumber +
        " via the pr-review post step. Not posted automatically — confirm to post._"
      : "");
  log("No confirmed findings — APPROVE.");
  return { confirmedFindings: [], report: cleanReport };
}

const severityRank = { CRITICAL: 0, SHOULD_FIX: 1, SUGGESTION: 2 };

// Synthesiser agent: dedup overlapping confirmed findings, prioritise, write the report.
const synthPrompt = `You are the synthesiser for a multi-dimension PR review of PR #${prNumber}: ${ctx.title || ""}.

You are given the CONFIRMED findings — each already survived an independent adversarial skeptic, so trust them; your job is to dedup, prioritise, and write one clean report. Do NOT invent new findings or re-litigate confirmed ones.

Confirmed findings (JSON):
${JSON.stringify(allConfirmed)}

Changed files:
${changedFileList}

Do this:
1. Deduplicate: when multiple findings target the same file and overlapping lines/issue, merge into one, keeping the clearest explanation+fix and the HIGHEST severity; note which dimensions independently flagged it.
2. Prioritise by severity (CRITICAL, then SHOULD_FIX, then SUGGESTION), then confidence. Cap SUGGESTIONs at 3 total — keep the most useful, mention how many were dropped.
3. Pick a verdict: REQUEST_CHANGES if any CRITICAL or SHOULD_FIX remains; otherwise APPROVE_WITH_SUGGESTIONS.
4. Write a concise markdown report: a title line, the verdict, a 2-3 sentence summary, findings grouped by severity (each with file:line, what, why, fix), and a collapsed "Files reviewed" list. Length should match severity — keep it short if findings are minor.${
  shouldPost
    ? '\n5. Because posting was requested, append a short "Posting" note describing how this would be posted to GitHub (map the verdict to a review event: REQUEST_CHANGES, otherwise COMMENT/APPROVE; inline comments only for CRITICAL/SHOULD_FIX) and state that it was NOT actually posted unless explicitly authorised.'
    : ""
}

Return ONLY the markdown report (no JSON, no code fence around the whole thing).`;

const report = await agent(synthPrompt, {
  label: "synthesize",
  phase: "Synthesize",
  agentType: "delegate",
  effort: "high",
});

// Deterministic ordering of the structured findings we return alongside the report.
const confirmedFindings = allConfirmed
  .slice()
  .sort((a, b) => {
    const sa = severityRank[a.severity] == null ? 3 : severityRank[a.severity];
    const sb = severityRank[b.severity] == null ? 3 : severityRank[b.severity];
    if (sa !== sb) return sa - sb;
    return (b.confidence || 0) - (a.confidence || 0);
  });

const finalReport =
  (typeof report === "string" && report.trim())
    ? report
    : "# Review of PR #" +
      prNumber +
      "\n\n" +
      confirmedFindings.length +
      " confirmed finding(s). (Synthesiser produced no prose; raw findings returned in confirmedFindings.)";

log(
  "Done: " +
    confirmedFindings.length +
    " confirmed finding(s) across " +
    (reviewedDimensions ? reviewedDimensions.length : 0) +
    " dimensions" +
    (shouldPost ? " (post requested — not posted automatically)" : ""),
);

return { confirmedFindings, report: finalReport };
