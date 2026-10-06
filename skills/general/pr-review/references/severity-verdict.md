# Severity, coverage and verdict contract

This contract applies to `pr-review`. It is bundled inside this skill so
individual installation/vendoring needs no sibling resource.

| Surviving findings / coverage | Verdict | Blocks via review event? |
| --- | --- | --- |
| Any verified CRITICAL | REQUEST_CHANGES | Yes; disclose any coverage gaps |
| No CRITICAL, the review itself could not be completed | INCOMPLETE | No; COMMENT review on the reviewed head, never an approval |
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
stream may pass its assessment and return findings. Missing/failed/null output
and pending/stale required CI are not passes. An unreadable ticket is a caveat,
not missing coverage: assess against the PR description and say so.

Required coverage is what this review has to do itself: read the diff and the
ticket, run each dimension, adjudicate findings, and check the verification it
owns. Separate four things that earlier rounds blurred together:

- **Review failure** (a stream failed, objects unreadable, a check this
  review owns could not run, with neither green current-head CI nor a local
  run to cover it): coverage is incomplete, so `INCOMPLETE`.
- **Unreadable ticket** (tool missing, not found, no access): requirements are
  assessed against the PR description and discussion, and the review says
  which ticket it could not read. A caveat, not `INCOMPLETE`.
- **External evidence** (database or runtime results, deployment or CronJob
  configuration, a criterion the ticket or PR discussion assigns to another
  card or owner): not required coverage. List it as a caveat with its owner.
  If its absence hides a real defect, raise that defect as a finding with a
  severity instead.
- **Evidence already supplied**: results, logs or decisions posted in the PR
  discussion count. Read the full comment before calling anything missing.

On a re-review, evidence gathered for an earlier exact head stays valid when
the intervening delta does not touch the code it covered. A gap listed by an
earlier round is not inherited automatically: re-check it against the current
discussion and delta. When every earlier blocking finding is verified resolved
and nothing new is found, the verdict is an approval, not `INCOMPLETE`.
When the caller explicitly requests `--independent-checks`, remote CI and
CodeRabbit are separate merge gates, not required code-review coverage. Record
their actual status, but do not wait for their completion or withhold the code
verdict solely because they are pending, failing, stale or unavailable. Verified
critical defects discovered in their output still count as findings. This mode
does not remove any other required assessment or independent challenge.
A not-applicable skip must have a reason and be optional. When publication is
authorized, `INCOMPLETE` is posted with `--verdict INCOMPLETE`: a COMMENTED
review pinned to the reviewed head that never approves, never requests changes
and never dismisses an earlier blocking review. Do not coerce it to
CHANGES_SUGGESTED, whose nonblocking comment dismisses an earlier block. A
confirmed critical may still be reported/posted as REQUEST_CHANGES with gaps
disclosed, when the caller authorized publication.

```js
function reviewVerdict(findings, coverageComplete) {
  if (findings.some((finding) => finding.severity === "CRITICAL")) return "REQUEST_CHANGES";
  if (!coverageComplete) return "INCOMPLETE";
  if (findings.some((finding) => finding.severity === "SHOULD_FIX")) return "CHANGES_SUGGESTED";
  if (findings.some((finding) => finding.severity === "SUGGESTION")) return "APPROVE_WITH_SUGGESTIONS";
  return "APPROVE";
}
```
