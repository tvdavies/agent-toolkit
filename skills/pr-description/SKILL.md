# PR Description

Use this skill when creating, editing, or improving a GitHub pull request description. Trigger phrases include "fix the PR description", "write a PR description", "create PR body", "format PR body", "update PR description", "make the PR description better", or before running `gh pr create` / `gh pr edit`.

## Goal

Produce a clear, well-formatted PR description that is useful to reviewers and safe to pass to GitHub without escaped newline issues.

## Rules

- Always write the body to a temporary Markdown file and use `--body-file`. Do **not** pass multi-line bodies via `--body "...\n..."`.
- Keep descriptions concise but complete.
- Use Markdown headings and bullets.
- Include validation commands exactly as run.
- Do not invent test results. If validation was not run, say `Not run` and why.
- Mention operational risk or rollout notes when relevant.
- For draft PRs, the body can still be production quality.

## Default Template

Use this structure unless the repo/ticket asks for something different:

```markdown
## Summary

- ...
- ...

## Context

Short explanation of why this change is needed. Link or mention incidents/tickets if available.

## Changes

- ...
- ...

## Validation

```bash
command that was run
```

Result: passed/failed/not run.

## Risk / Rollback

- Risk: ...
- Rollback: ...
```

If a section would be empty, either omit it or write a single useful sentence. Do not leave placeholders.

## Creating a PR

1. Inspect the diff and recent commits:

```bash
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

2. Write the PR body to a file:

```bash
cat > /tmp/pr-body.md <<'EOF'
## Summary

- ...

## Context

...

## Validation

```bash
...
```
EOF
```

3. Create the PR using `--body-file`:

```bash
gh pr create --draft --base main --head BRANCH --title "Title" --body-file /tmp/pr-body.md
```

## Editing an Existing PR

1. Read the current PR body:

```bash
gh pr view PR_NUMBER --json body --jq .body
```

2. Write the replacement body to a file:

```bash
cat > /tmp/pr-body.md <<'EOF'
...
EOF
```

3. Update via `--body-file`:

```bash
gh pr edit PR_NUMBER --body-file /tmp/pr-body.md
```

4. Verify formatting:

```bash
gh pr view PR_NUMBER --json body --jq .body
```

## Optional Helper Script

This skill includes `scripts/write-pr-body.sh`, which writes a template to `/tmp/pr-body.md` for editing before PR creation/update.

Usage:

```bash
/home/tvd/.claude/skills/pr-description/scripts/write-pr-body.sh
```

Then edit `/tmp/pr-body.md` and pass it to GitHub CLI with `--body-file /tmp/pr-body.md`.
