# Skill Building Reference Guide

Condensed reference from "The Complete Guide to Building Skills for Claude" by Anthropic.

## What is a Skill?

A skill is a folder containing:
- **SKILL.md** (required): Instructions in Markdown with YAML frontmatter
- **scripts/** (optional): Executable code (Python, Bash, etc.)
- **references/** (optional): Documentation loaded as needed
- **assets/** (optional): Templates, fonts, icons used in output

## Progressive Disclosure (Three Levels)

1. **First level (YAML frontmatter)**: Always loaded in system prompt. Tells Claude WHEN to use the skill.
2. **Second level (SKILL.md body)**: Loaded when Claude decides the skill is relevant. Contains full instructions.
3. **Third level (Linked files)**: Additional files in the skill directory. Claude navigates and discovers as needed.

This minimizes token usage while maintaining specialized expertise.

## Critical Naming Rules

### SKILL.md
- Must be exactly `SKILL.md` (case-sensitive)
- No variations: SKILL.MD, skill.md, Skill.md are all WRONG

### Folder Name
- kebab-case only: `notion-project-setup`
- No spaces: `Notion Project Setup` is WRONG
- No underscores: `notion_project_setup` is WRONG
- No capitals: `NotionProjectSetup` is WRONG

### No README.md
- Don't include README.md inside the skill folder
- All documentation goes in SKILL.md or references/

## YAML Frontmatter

### Required Fields

```yaml
---
name: skill-name-in-kebab-case
description: What it does and when to use it. Include specific trigger phrases.
---
```

### name (required)
- kebab-case only
- No spaces or capitals
- Should match folder name

### description (required)
- MUST include BOTH: What the skill does + When to use it (trigger conditions)
- Under 1024 characters
- No XML tags
- Include specific tasks users might say
- Mention file types if relevant

**Formula**: [What it does] + [When to use it] + [Key capabilities]

**Good examples**:
```
description: Analyzes Figma design files and generates developer handoff documentation. Use when user uploads .fig files, asks for "design specs", "component documentation", or "design-to-code handoff".
```

```
description: Manages Linear project workflows including sprint planning, task creation, and status tracking. Use when user mentions "sprint", "Linear tasks", "project planning", or asks to "create tickets".
```

**Bad examples**:
```
# Too vague
description: Helps with projects.

# Missing triggers
description: Creates sophisticated multi-page documentation systems.

# Too technical, no user triggers
description: Implements the Project entity model with hierarchical relationships.
```

### Optional Fields

- **license**: MIT, Apache-2.0, etc.
- **compatibility**: Environment requirements (1-500 chars)
- **metadata**: Custom key-value pairs (author, version, mcp-server, etc.)
- **allowed-tools**: Restrict which tools the skill can use

## Security Restrictions

**Forbidden in frontmatter:**
- XML angle brackets (< >)
- Skills with "claude" or "anthropic" in name (reserved)

**Why**: Frontmatter appears in system prompt. Malicious content could inject instructions.

## Writing Effective Instructions

### Recommended SKILL.md Structure

```markdown
---
name: your-skill
description: [...]
---

# Your Skill Name

## Instructions

### Step 1: [First Major Step]
Clear explanation of what happens.

### Step 2: [Next Step]
...

## Examples

### Example 1: [Common scenario]
User says: "..."
Actions:
1. ...
2. ...
Result: ...

## Common Issues

### [Error Message]
Cause: ...
Solution: ...
```

### Be Specific and Actionable

**Good**:
```
Run `python scripts/validate.py --input {filename}` to check data format.
If validation fails, common issues include:
- Missing required fields (add them to the CSV)
- Invalid date formats (use YYYY-MM-DD)
```

**Bad**:
```
Validate the data before proceeding.
```

### Include Error Handling

```markdown
## Common Issues

### MCP Connection Failed
If you see "Connection refused":
1. Verify MCP server is running: Check Settings > Extensions
2. Confirm API key is valid
3. Try reconnecting: Settings > Extensions > [Your Service] > Reconnect
```

### Reference Bundled Resources Clearly

```
Before writing queries, consult `references/api-patterns.md` for:
- Rate limiting guidance
- Pagination patterns
- Error codes and handling
```

### Keep SKILL.md Focused
- Move detailed documentation to `references/` and link to it
- Keep SKILL.md under 5,000 words

## Common Skill Patterns

### Pattern 1: Sequential Workflow Orchestration
Use when: Multi-step processes in a specific order.
Key techniques: Explicit step ordering, dependencies between steps, validation at each stage, rollback instructions for failures.

### Pattern 2: Multi-MCP Coordination
Use when: Workflows span multiple services.
Key techniques: Clear phase separation, data passing between MCPs, validation before moving to next phase, centralized error handling.

### Pattern 3: Iterative Refinement
Use when: Output quality improves with iteration.
Key techniques: Explicit quality criteria, iterative improvement loops, validation scripts, know when to stop iterating.

### Pattern 4: Context-Aware Tool Selection
Use when: Same outcome, different tools depending on context.
Key techniques: Clear decision criteria, fallback options, transparency about choices.

### Pattern 5: Domain-Specific Intelligence
Use when: Your skill adds specialized knowledge beyond tool access.
Key techniques: Domain expertise embedded in logic, compliance before action, comprehensive documentation, clear governance.

## Choosing Problem-First vs. Tool-First

- **Problem-first**: "I need to set up a project workspace" -- Skill orchestrates the right MCP calls in the right sequence. Users describe outcomes; the skill handles the tools.
- **Tool-first**: "I have Notion MCP connected" -- Skill teaches Claude optimal workflows and best practices. Users have access; the skill provides expertise.

## Troubleshooting

### Skill Won't Upload
- **"Could not find SKILL.md"**: Rename to exactly SKILL.md (case-sensitive)
- **"Invalid frontmatter"**: Check YAML formatting. Use `---` delimiters. No unclosed quotes.
- **"Invalid skill name"**: Name has spaces or capitals. Use kebab-case.

### Skill Doesn't Trigger
- Description is too generic
- Missing trigger phrases users would actually say
- Missing relevant file types
- **Debug**: Ask Claude "When would you use the [skill name] skill?" and adjust based on response.

### Skill Triggers Too Often
1. Add negative triggers: "Do NOT use for [unrelated task] (use [other-skill] instead)."
2. Be more specific in the description
3. Clarify scope: "Use specifically for X, not for general Y."

### Instructions Not Followed
1. Instructions too verbose -- keep concise, use bullet points
2. Instructions buried -- put critical ones at the top with ## Important headers
3. Ambiguous language -- be explicit: "CRITICAL: Before calling create_project, verify: Project name is non-empty, At least one team member assigned"
4. Model "laziness" -- add: "Take your time to do this thoroughly. Quality is more important than speed."

### Large Context Issues
- Skill content too large -- move docs to references/, keep SKILL.md under 5,000 words
- Too many skills enabled -- evaluate if more than 20-50 are needed simultaneously

## Quick Validation Checklist

### Before You Start
- [ ] Identified 2-3 concrete use cases
- [ ] Tools identified (built-in or MCP)
- [ ] Planned folder structure

### During Development
- [ ] Folder named in kebab-case
- [ ] SKILL.md file exists (exact spelling)
- [ ] YAML frontmatter has --- delimiters
- [ ] name field: kebab-case, no spaces, no capitals
- [ ] description includes WHAT and WHEN
- [ ] No XML tags anywhere
- [ ] Instructions are clear and actionable
- [ ] Error handling included
- [ ] Examples provided
- [ ] References clearly linked

### Before Upload/Install
- [ ] Tested triggering on obvious tasks
- [ ] Tested triggering on paraphrased requests
- [ ] Verified doesn't trigger on unrelated topics
- [ ] Functional tests pass

## Skill Distribution

### For Claude Code
Place in:
- User-level: `~/.claude/skills/[name]/`
- Project-level: `.claude/skills/[name]/`

### For Claude.ai
1. Download the skill folder
2. Zip the folder
3. Upload via Settings > Capabilities > Skills

### For GitHub
- Host as a public repo
- Include clear README (separate from SKILL.md, for humans)
- Add installation instructions and example usage
