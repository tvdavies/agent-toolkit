# Severity, coverage and verdict contract

This contract applies to portable `pr-review` and saved `review-pr`. It is bundled
inside this skill so individual installation/vendoring needs no sibling resource.
The saved workflow cannot import host files: its deterministic function below is
mirrored verbatim, and toolkit tests reject drift. Change both together.

| Surviving findings / coverage | Verdict | Blocks via review event? |
| --- | --- | --- |
| Any verified CRITICAL | REQUEST_CHANGES | Yes; disclose any coverage gaps |
| No CRITICAL, incomplete REQUIRED coverage | INCOMPLETE | No approval; report only |
| Any SHOULD_FIX, complete required coverage | CHANGES_SUGGESTED | No; COMMENT |
| Only SUGGESTION, complete required coverage | APPROVE_WITH_SUGGESTIONS | No; APPROVE |
| No findings, complete required coverage | APPROVE | No; APPROVE |

CRITICAL means a demonstrated, reachable merge-blocking defect: security, data
loss/corruption, broken required build or user-visible breakage. SHOULD_FIX is a
real important issue worth fixing, but does not set a blocking review state.
Never inflate it to force a block. SUGGESTION is optional. Confidence and severity
are different: depth of analysis alone is not severity evidence.

`coverageComplete` means every required dimension, independent challenge and
verification check completed successfully for the reviewed head/scope. A review
stream may pass its assessment and return findings. Missing/failed/null output,
unavailable required ticket context, and pending/stale required CI are not passes.
A not-applicable skip must have a reason and be optional. `INCOMPLETE` is not a
GitHub helper verdict; do not coerce it to a nonblocking comment that dismisses
an earlier blocking review. A confirmed critical may still be reported/posted as
REQUEST_CHANGES with gaps disclosed, when the caller authorized publication.

```js
function reviewVerdict(findings, coverageComplete) {
  if (findings.some((finding) => finding.severity === "CRITICAL")) return "REQUEST_CHANGES";
  if (!coverageComplete) return "INCOMPLETE";
  if (findings.some((finding) => finding.severity === "SHOULD_FIX")) return "CHANGES_SUGGESTED";
  if (findings.some((finding) => finding.severity === "SUGGESTION")) return "APPROVE_WITH_SUGGESTIONS";
  return "APPROVE";
}
```
