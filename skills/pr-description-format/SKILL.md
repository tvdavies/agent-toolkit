---
name: pr-description-format
description: Prevents malformed GitHub PR descriptions with literal newline escapes. Use when creating or editing a PR, running gh pr create, gh pr edit, updating a PR body, or when the user asks to fix PR description formatting.
metadata:
  author: tvd
  version: 1.0.0
---

# PR Description Format

## Important

Never pass multi-line Markdown directly through a quoted `--body` argument with escaped newlines. This often writes literal `\n` text into the GitHub PR description.

Always write the PR body to a temporary Markdown file and use `--body-file`.

## Instructions

### Step 1: Build the PR body as a Markdown file

Use the write tool to create `/tmp/pr-body.md` with real line breaks. Example content:

```markdown
## Summary

- First summary item
- Second summary item

## Verification

- `command that was run`
```

Use concise sections. Prefer at least:

- `## Summary`
- `## Verification`

If there was no verification, write `Not run` with a short reason.

### Step 2: Create or edit the PR using the file

For a new PR:

```bash
gh pr create --base main --head branch-name --title "PR title" --body-file /tmp/pr-body.md
```

For an existing PR:

```bash
gh pr edit PR_NUMBER --body-file /tmp/pr-body.md
```

### Step 3: Verify the rendered body

Immediately check the body after creating or editing:

```bash
gh pr view PR_NUMBER --json body --jq .body
```

Confirm that:

- Section headings are on separate lines.
- Bullet points are on separate lines.
- Commands are wrapped in backticks when appropriate.
- There are no literal `\n` sequences.

If literal `\n` appears, rewrite the body file and run `gh pr edit PR_NUMBER --body-file /tmp/pr-body.md`.

## Examples

### Creating a PR

User says: "Create the PR"

Actions:
1. Write `/tmp/pr-body.md` with Markdown and real line breaks.
2. Run `gh pr create ... --body-file /tmp/pr-body.md`.
3. Run `gh pr view ... --json body --jq .body`.
4. Fix immediately if the output contains literal `\n`.

### Fixing a malformed PR body

User says: "Fix formatting of PR description"

Actions:
1. Inspect the current body with `gh pr view PR_NUMBER --json body --jq .body`.
2. Write a clean Markdown body to `/tmp/pr-body.md`.
3. Run `gh pr edit PR_NUMBER --body-file /tmp/pr-body.md`.
4. Verify the body again.

## Common Issues

### Literal newline escapes appear in the PR body

Cause: The body was passed as a quoted shell argument containing `\n`.

Fix:
1. Rewrite the body in a real Markdown file.
2. Update with `--body-file`.
3. Verify with `gh pr view`.

### Markdown code spans look wrong

Cause: The shell interpreted characters while building the body.

Fix: Use the write tool instead of shell quoting for PR body files.
