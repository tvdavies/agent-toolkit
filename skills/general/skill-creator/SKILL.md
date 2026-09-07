---
name: skill-creator
description: Interactive guide for building portable Agent Skills. Walks the user through use case definition, frontmatter generation, instruction writing, and validation. Use when user says "create a skill", "build a skill", "new skill", "make a skill", or "skill creator".
metadata:
  author: tvd
  version: 1.0.0
---

# Skill Creator

Build well-structured portable Agent Skills. Use the caller's supplied context,
follow the steps in order, and validate without requiring a particular model.

## Portable contract

State activation, inputs, deliverable, allowed effects, required capabilities,
completion evidence and escalation owner. A skill is procedure, not permission
to publish, implement, merge or widen scope. Headless mode is separate from
authority. Discover active tool schemas; do not invent provider-specific calls,
mandatory model names or host paths. If delegation is needed, use only approved
tools, verify isolation and one writer per checkout, and provide a safe direct
or blocked outcome. Never use an agent CLI via shell as a fallback.

Bundle references/scripts inside the skill with relative links. If another skill
is optional, discover it by installed name and supply a concise fallback; do not
require a sibling path that breaks individual installation. Test unavailable
capabilities, safety boundaries, negative triggers and partial completion, not
only the happy path. No paid model evaluations without explicit opt-in.

## Important Rules

Before generating ANY skill content, internalize these rules:

- SKILL.md is the ONLY required file (case-sensitive, exact spelling)
- Folder name MUST be kebab-case (no spaces, underscores, or capitals)
- The `name` field MUST be kebab-case and match the folder name
- The `description` field MUST include WHAT the skill does AND WHEN to use it (trigger phrases)
- Description must be under 1024 characters
- Avoid XML tags in frontmatter; preserve necessary code/template syntax in instructions
- Prefer a task-oriented name over provider branding; check the target host's validation rules
- NO README.md inside the skill folder
- Keep SKILL.md under 5,000 words; move detailed docs to `references/`

Consult `references/skill-guide-reference.md` for detailed rules, patterns, and examples.

## Step 1: Gather Use Case

Ask the user these questions (one message, wait for answers):

1. **What should this skill do?** (What outcome does the user want?)
2. **When should it trigger?** (What phrases or situations activate it?)
3. **What capabilities does it need?** (Available host tools, MCP integrations, or none?)
4. **Is this standalone or does it enhance an MCP integration?**

If the user already provided this context, skip to Step 2.

## Step 2: Define the Skill Identity

Based on the answers, determine:

- **Folder name**: kebab-case, descriptive (e.g., `sprint-planner`, `code-reviewer`)
- **name field**: Must match folder name exactly
- **description field**: Follow the formula: [What it does] + [When to use it] + [Key capabilities]

### Description Quality Checklist
Before finalizing the description, verify:
- It is specific and actionable (not vague like "Helps with projects")
- It includes trigger phrases users would actually say
- It mentions relevant file types if applicable
- It does NOT use XML tags
- It is under 1024 characters

Present the proposed name and description to the user for approval before continuing.

## Step 3: Generate the SKILL.md

Build the full SKILL.md file using this structure:

```
---
name: [kebab-case-name]
description: [What + When + Capabilities, under 1024 chars]
metadata:
  author: [user or org name]
  version: 1.0.0
---

# [Skill Display Name]

## Instructions

### Step 1: [First Major Step]
Clear explanation of what happens.

### Step 2: [Next Step]
Clear explanation with specific, actionable instructions.

[Continue for all steps...]

## Examples

### Example 1: [Common scenario]
User says: "[typical request]"
Actions:
1. [First action]
2. [Second action]
Result: [Expected outcome]

## Common Issues

### [Issue Name]
If you see "[error or symptom]":
1. [Fix step 1]
2. [Fix step 2]
```

### Writing Guidelines for Instructions
- Be specific and actionable: `Run python scripts/validate.py --input {filename}` not `Validate the data`
- Use bullet points and numbered lists
- Put critical instructions at the top under ## Important headers
- Include error handling for common failure modes
- Reference bundled files clearly: `consult references/api-guide.md for...`

## Step 4: Determine Additional Files

Ask the user if the skill needs:

- **scripts/**: Executable code (Python, Bash, etc.) for the skill to invoke
- **references/**: Documentation the agent can consult as needed
- **assets/**: Templates, fonts, icons used in output

Create any needed files with appropriate content.

## Step 5: Validate the Skill

Run through this checklist and report results to the user:

### Structure Checks
- [ ] Folder is named in kebab-case
- [ ] SKILL.md file exists (exact spelling)
- [ ] YAML frontmatter has `---` delimiters
- [ ] `name` field is kebab-case, matches folder name
- [ ] `description` includes WHAT and WHEN
- [ ] Frontmatter validates under the target host's supported Agent Skills format
- [ ] Code, schemas, quotations and required templates retain their literal syntax

### Content Checks
- [ ] Instructions are clear and actionable
- [ ] Error handling included
- [ ] Examples provided
- [ ] References clearly linked (if applicable)

### Trigger Test
Suggest 3 phrases that SHOULD trigger the skill and 3 that should NOT. Ask the user to verify.

## Step 6: Install the Skill

Confirm the target host's discovery rules and the caller's desired scope before
writing. Standard locations commonly include `~/.agents/skills/[name]/` for
user-level and `.agents/skills/[name]/` for project-level resources; support
varies by host. Use the caller's actual configured destination, not a guessed
Claude/Pi path. In this toolkit, author in the appropriate `skills/` group and
use its documented sync procedure only when installation is authorized.

Write only to the chosen location, preserve unmanaged existing files, and do not
edit live global settings or install MCP servers as an implicit creation step.

## Step 7: Summary

After installation, provide:
- Location of all created files
- How to test: "Try the installed skill with: [example trigger phrase]"
- How to iterate: "If the skill doesn't trigger correctly, adjust the description field. If instructions aren't followed, make them more specific and concise."
- Link to the guide: Consult `references/skill-guide-reference.md` for patterns and troubleshooting
