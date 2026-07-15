# GitHub PR Comment Format

This document defines the template and formatting rules for posting PR review results as a GitHub comment. Only load this file when the user requests posting to GitHub (via `--post` flag or "post to PR" / "post to GitHub").

## Report Templates

Write the complete markdown to `$REVIEW_TMPDIR/pr-review.md` before posting. Initialise the directory first:

```bash
REVIEW_TMPDIR="${PR_REVIEW_TMPDIR:-${TMPDIR:-/tmp}}"
mkdir -p "$REVIEW_TMPDIR"
```

Use the appropriate template based on the verdict.

### APPROVE Template

For clean PRs with no findings or only minor positives. Keep it short.

```markdown
## ✅ Approved

**{COMMIT_COUNT}** commits | **{FILE_COUNT}** files changed | **{ADDITIONS}** additions | **{DELETIONS}** deletions

{SUMMARY — one short sentence stating why the PR is fine. Wrap any extra context in a `<details><summary>More context</summary>...</details>` block.}

---
```

No findings sections, no "What's Good" padding, no build status (CI covers that), no Files Reviewed section (GitHub's Files Changed tab covers that).

### APPROVE_WITH_SUGGESTIONS Template

Same condensed format but with a visible suggestions section (max 3 items, not collapsible — they should be visible since they're genuinely useful).

```markdown
## 🔵 Approved with Suggestions

**{COMMIT_COUNT}** commits | **{FILE_COUNT}** files changed | **{ADDITIONS}** additions | **{DELETIONS}** deletions

{SUMMARY — 1-2 punchy sentences. Wrap any longer rationale in a `<details><summary>More context</summary>...</details>` block.}

---

### 🔵 Suggestions

{SUGGESTION_1}

{SUGGESTION_2}

{SUGGESTION_3 — max 3 total}

---
```

### CHANGES_SUGGESTED Template

Should-fix findings but no criticals. Posted as a non-blocking comment — say so explicitly, so the author knows nothing here gates the merge.

```markdown
## 🟠 Changes Suggested (non-blocking)

**{COMMIT_COUNT}** commits | **{FILE_COUNT}** files changed | **{ADDITIONS}** additions | **{DELETIONS}** deletions

{SUMMARY — 1-2 punchy sentences. State that nothing blocks the merge; these are worth fixing but a human approver can weigh them.}

---

{SHOULD_FIX_SECTION}

{SUGGESTION_SECTION — only if suggestion findings exist, max 3}

---
```

### REQUEST_CHANGES Template

Full output with all severity sections.

```markdown
## 🔴 Changes Requested

**{COMMIT_COUNT}** commits | **{FILE_COUNT}** files changed | **{ADDITIONS}** additions | **{DELETIONS}** deletions

{SUMMARY — 1-2 punchy sentences stating the headline reason for the verdict. Wrap any longer rationale in a `<details><summary>More context</summary>...</details>` block.}

---

{TICKET_SECTION — only if ticket found}

{CRITICAL_SECTION — only if critical findings exist}

{SHOULD_FIX_SECTION — only if should-fix findings exist}

{SUGGESTION_SECTION — only if suggestion findings exist, max 3}

---
```

## Verdict Badges

Use these exact strings based on the verdict:

- APPROVE: `**✅ Approved**`
- APPROVE_WITH_SUGGESTIONS: `**🔵 Approved with Suggestions**`
- CHANGES_SUGGESTED: `**🟠 Changes Suggested (non-blocking)**`
- REQUEST_CHANGES: `**🔴 Changes Requested**`

## Ticket Compliance Section

Only include if a ticket was found. The status headline MUST be the only thing visible without expansion; the rationale and requirement breakdown go inside the collapsible block.

```markdown
<details>
<summary>📋 Ticket Compliance — {TICKET_ID} — {STATUS_HEADLINE}</summary>

{COMPLIANCE_SUMMARY — brief assessment}

{REQUIREMENT_LIST — if specific requirements were checked}

</details>
```

**Status headline format** — pick one based on the assessment, keep it on one line:
- `✅ All N criteria met`
- `🟡 N/M criteria met` — most met, with partial or scope gaps
- `🔴 N criteria not met` — outright gaps that block merge

## Severity Sections

Each severity tier is a collapsible section with a count in the summary line. Only include sections that have findings.

### Critical Issues

```markdown
<details>
<summary>🔴 Critical Issues ({COUNT})</summary>

### {FINDING_TITLE}
**File:** `{FILE_PATH}` **Lines:** {LINE_RANGE}

{WHAT} — {WHY}

<details>
<summary>💡 Suggested fix</summary>

```{LANGUAGE}
{CODE_SUGGESTION}
```

</details>

---

</details>
```

### Should Fix

```markdown
<details>
<summary>🟠 Should Fix ({COUNT})</summary>

### {FINDING_TITLE}
**File:** `{FILE_PATH}` **Lines:** {LINE_RANGE}

{WHAT} — {WHY}

<details>
<summary>💡 Suggested fix</summary>

{FIX_DESCRIPTION_OR_CODE}

</details>

---

</details>
```

### Suggestions

```markdown
<details>
<summary>🔵 Suggestions ({COUNT})</summary>

### {FINDING_TITLE}
**File:** `{FILE_PATH}` **Lines:** {LINE_RANGE}

{WHAT} — {WHY}

<details>
<summary>💡 Suggested fix</summary>

{FIX_DESCRIPTION_OR_CODE}

</details>

---

</details>
```

## Formatting Rules

1. **No raw HTML except `<details>` and `<summary>`** — GitHub markdown renders these natively
2. **Horizontal rules** (`---`) between findings within a severity section for visual separation
3. **Code blocks** with language hints for suggested fixes (typescript, sql, json, etc.)
4. **Backtick file paths** — always wrap file paths in backticks
5. **No trailing whitespace** in the generated markdown
6. **Empty sections** — do not include a severity section if there are zero findings for it
7. **Maximum comment size** — GitHub has a 65536 character limit. If the review exceeds this, truncate suggestion-level findings first, then should-fix findings, keeping all critical findings
8. **Unicode emoji only** — never use markdown emoji shortcodes (`:red_circle:`, `:warning:`, etc.). GitHub does not render shortcodes inside `<summary>` or other HTML tags. Always use Unicode emoji characters directly (🔴, 🟠, 🔵, ✅, 💡, ⚠️, 🆕, 📋)

## Incremental Review Template

When posting an incremental re-review (`--since`), use this template instead of the full review template. Always post as a **new comment** — never use `--edit-last` for incremental reviews, so the PR timeline preserves the progression.

```markdown
## {VERDICT_BADGE} Incremental Review

Since `{COMMIT_SHA}` — **{NEW_COMMIT_COUNT}** new commits | **{FILE_COUNT}** files changed

{SUMMARY — 1-2 punchy sentences covering the delta. Wrap any longer rationale in a `<details><summary>More context</summary>...</details>` block.}

---

### Progress

| | Count |
|---|---|
| ✅ Resolved | {RESOLVED_COUNT} |
| ⚠️ Still Open | {STILL_OPEN_COUNT} |
| 🆕 New Findings | {NEW_COUNT} |

{RESOLVED_SECTION — only if resolved findings exist}

{STILL_OPEN_SECTION — only if still-open findings exist}

{NEW_FINDINGS_SECTION — only if new findings exist}

---
```

### Resolved Section

Show resolved findings with strikethrough titles to visually indicate they're done:

```markdown
<details>
<summary>✅ Resolved ({COUNT})</summary>

- ~~Missing auth check on billing endpoint~~ — `src/api/billing.ts`
- ~~Unbounded query in user search~~ — `src/api/users.ts`
- ~~Hardcoded API key in config~~ — `src/config.ts`

</details>
```

### Still Open Section

Same format as the severity sections in the full review, but prefixed with a "still open" label. Group by severity within this section:

```markdown
<details>
<summary>⚠️ Still Open ({COUNT})</summary>

**🔴 Critical**

### {FINDING_TITLE}
**File:** `{FILE_PATH}` **Lines:** {LINE_RANGE}

{WHAT} — {WHY}

<details>
<summary>💡 Suggested fix</summary>

{FIX_DESCRIPTION_OR_CODE}

</details>

---

**🟠 Should Fix**

### {FINDING_TITLE}
...

</details>
```

### New Findings Section

Same format as severity sections in the full review, grouped by severity:

```markdown
<details>
<summary>🆕 New Findings ({COUNT})</summary>

**🔴 Critical**

### {FINDING_TITLE}
**File:** `{FILE_PATH}` **Lines:** {LINE_RANGE}

{WHAT} — {WHY}

<details>
<summary>💡 Suggested fix</summary>

{FIX_DESCRIPTION_OR_CODE}

</details>

---

</details>
```

### Incremental Verdict Rules

The verdict is based on **Still Open + New** findings combined (resolved findings are excluded):
- APPROVE: No critical or should-fix findings remaining
- APPROVE_WITH_SUGGESTIONS: Only suggestions remaining
- REQUEST_CHANGES: At least one critical or should-fix finding still open or newly introduced

**Incremental inline comments:** Only generate inline comments for NEW findings. Still-open findings already have conversation threads from the prior review — adding duplicates creates noise.

## Inline Review Comments

CRITICAL and SHOULD_FIX findings get posted as inline review comments on the specific lines in the diff. This creates GitHub conversation threads that must be resolved before merge. SUGGESTION findings are body-only — no inline thread.

### Inline Comment Template

Format each inline comment using this template:

```markdown
**{SEVERITY_BADGE} {TITLE}**

{WHAT}

{WHY}

{FIX_SECTION}

---
<sub>Full context in the PR review comment above.</sub>
```

Severity badges for inline comments:
- `🔴 Critical` — for CRITICAL findings
- `🟠 Should Fix` — for SHOULD_FIX findings

FIX_SECTION: A code block with language hint showing the suggested fix, or a plain text instruction if no code change applies.

### Inline JSON Format

Write inline comments to `$REVIEW_TMPDIR/pr-review-inline.json`:

```json
{
  "comments": [
    {
      "path": "src/api/billing.ts",
      "line": 48,
      "start_line": 45,
      "body": "**🔴 Critical — Missing auth check**\n\nThe billing endpoint...\n\n---\n<sub>Full context in the PR review comment above.</sub>",
      "severity": "CRITICAL",
      "title": "Missing auth check"
    }
  ]
}
```

Fields:
- `path` — file path relative to repo root (must match the diff)
- `line` — end line of the range (required)
- `start_line` — start line of the range (omit if same as `line`)
- `body` — formatted markdown using the template above
- `severity` — `CRITICAL` or `SHOULD_FIX` (metadata for logging, not sent to API)
- `title` — short finding title (metadata for logging, not sent to API)

### Review Event Mapping

Map the review verdict to a GitHub review event:

| Verdict | Event |
|---------|-------|
| REQUEST_CHANGES | REQUEST_CHANGES |
| CHANGES_SUGGESTED | COMMENT |
| APPROVE_WITH_SUGGESTIONS | APPROVE |
| APPROVE | APPROVE |

CHANGES_SUGGESTED maps to COMMENT deliberately: should-fix findings inform the author and the human approver without setting a blocking review state. Inline comments are still posted for each SHOULD_FIX finding so they get resolvable threads.

When `PRSMASH_APPROVAL_LINE_LIMIT` is set by automation, `post-review.sh` will downgrade `APPROVE` events to `COMMENT` for PRs whose additions + deletions are greater than or equal to that limit. The body still carries the `Approved` / `Approved with Suggestions` verdict, but includes a manual-approval banner and marker so the caller can report that a human reviewer must approve the PR manually.

## Posting Commands

Use the `post-review.sh` script for all posting. It handles body comment + inline review as two separate operations, with validation and graceful fallback.

### Full review with inline comments
```bash
bash scripts/post-review.sh \
    --body $REVIEW_TMPDIR/pr-review.md \
    --inline $REVIEW_TMPDIR/pr-review-inline.json \
    --event REQUEST_CHANGES \
    --pr 1234
```

### Body only (no inline comments)
```bash
bash scripts/post-review.sh \
    --body $REVIEW_TMPDIR/pr-review.md --event APPROVE --pr 1234
```

### Update existing review comment
```bash
bash scripts/post-review.sh \
    --body $REVIEW_TMPDIR/pr-review.md --edit-last --pr 1234
```

### Dry run (inspect payload without posting)
```bash
bash scripts/post-review.sh \
    --body $REVIEW_TMPDIR/pr-review.md --inline $REVIEW_TMPDIR/pr-review-inline.json \
    --event REQUEST_CHANGES --pr 1234 --dry-run
```

**Important:** Always pass `--pr NUMBER` explicitly. Never rely on auto-detection from the current branch. Never call `gh pr review` directly — the script handles review submission atomically.

### If no PR exists
Inform the user that no PR was found and offer to create one, or just output the review conversationally.
