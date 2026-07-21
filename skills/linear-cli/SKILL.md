---
name: linear-cli
description: Manages Linear issues, projects, sprints, and workflows using the linear-cli command line tool. Use when user mentions "linear", "issues", "tickets", "sprint", "backlog", "triage", asks to "create an issue", "check my tasks", "sprint status", "update issue", "what am I working on", or references Linear issue IDs like LIN-123. Replaces the Linear MCP server with reliable CLI-based operations.
metadata:
  author: tvd
  version: 1.0.0
---

# Linear CLI

Manage Linear issues, projects, sprints, and workflows via `linear-cli`.

## Important: Default Team

The default team is **LLE** (Lleverage). When the user doesn't specify a team, use LLE. Other available teams: LEG, LLEV, DES, EDU, FDE.

## Important: Agent Output Conventions

When running `linear-cli` commands:
- Always use `--output json --compact` for programmatic parsing
- Use `--no-pager` to prevent interactive paging
- Use `--yes` for non-interactive confirmations on destructive operations
- Use `--fields` to limit token usage when only specific fields are needed
- Use `--quiet` to suppress decorative output
- When displaying results to the user, format them in a readable summary

Standard agent flags: `--output json --compact --no-pager --quiet`

## Wrapper Scripts

Helper scripts are in `scripts/` within this skill directory. They accept both human-friendly (table) and agent-friendly (json) output.

| Script | Purpose |
|--------|---------|
| `my-issues` | Dashboard of assigned issues (current cycle by default, `--all` for everything) |
| `sprint-status` | Sprint progress and remaining work |
| `start-issue` | Set In Progress + assign + checkout branch |
| `finish-issue` | Mark current branch's issue as Done |
| `triage` | Show unassigned/untriaged issues |
| `quick-create` | Create issue with common defaults |
| `get-issue-context` | Extract all media from an issue: screenshots, Loom video frames, transcripts |
| `upload-attachment` | Upload a LOCAL file and attach it to an issue (handles Linear's `fileUpload` flow) |

Run any script with `--help` for usage.

## Instructions

### Step 1: Determine the Request Type

Classify what the user wants:

- **Read/Query**: listing issues, checking status, viewing sprint progress, searching
- **Create**: creating issues, projects, comments
- **Update**: changing status, assigning, moving issues
- **Workflow**: compound actions like starting/finishing work on an issue
- **Git Integration**: checking out branches, creating PRs from issues

### Step 2: Choose the Right Approach

For **simple operations**, use `linear-cli` directly:

```bash
# List my issues
linear-cli issues list --mine --output json --compact --no-pager --quiet

# Get issue details
linear-cli issues get LIN-123 --output json --compact --no-pager --quiet

# Create an issue
linear-cli issues create "Title" -t TEAM -p 3 --output json --compact --no-pager --quiet

# Search
linear-cli search issues "query" --output json --compact --no-pager --quiet
```

For **common workflows**, use the wrapper scripts:

```bash
# What am I working on?
bash scripts/my-issues.sh

# Current sprint overview
bash scripts/sprint-status.sh TEAM

# Start working on an issue
bash scripts/start-issue.sh LIN-123

# Finish the current issue
bash scripts/finish-issue.sh

# Triage unassigned work
bash scripts/triage.sh TEAM

# Quick create (use flags for options, not positional args)
bash scripts/quick-create.sh TEAM "Title" -p 3 -a me
```

### Step 2a: Attaching Local Files to Issues

`linear-cli attachments create` can only link an **existing `--url`** — it cannot upload a
local file. To attach a real file (markdown plan, PDF, screenshot, CSV, …) use the wrapper,
which drives Linear's `fileUpload` GraphQL mutation:

```bash
bash scripts/upload-attachment.sh LLE-123 ./plan.md -T "Implementation plan" -s "v1"
```

Under the hood (do this manually only if the script is unavailable):

1. **`fileUpload` mutation** → returns a presigned (GCS-backed) `uploadUrl`, the final
   `uploads.linear.app` `assetUrl`, and a list of **required** `headers`
   (e.g. `x-goog-content-length-range` locking exact byte size, and `Content-Disposition`).
2. **`PUT` the file** to `uploadUrl` with those **exact** headers + `Content-Type` (expect HTTP 200).
3. **`linear-cli attachments create ISSUE --title … --url <assetUrl>`** to link it.

Needs `curl`, `jq`, and an API key (`LINEAR_API_KEY` or `api_key` in
`~/.config/linear-cli/config.toml`). The mutation needs the correct byte `size` and a
`contentType`; mismatches fail the storage `PUT`.

### Step 2b: Retrieving Visual Context from Issues

Issues often contain screenshots and Loom video recordings. When working on an issue, **always extract visual context** - it's often the most important information.

```bash
# Extract all media: screenshots, Loom frames, transcripts
bash scripts/get-issue-context.sh LLE-123
bash scripts/get-issue-context.sh LLE-123 --comments  # include comment media
```

The script returns JSON listing all downloaded files. Then use the Read tool to view each image.

**What it extracts:**
- **Screenshots**: Images embedded in the description/comments via `uploads.linear.app`
- **Loom videos**: High-res frames (1280x720 from thumbnail MP4), full-video frames (640x360 from full-play GIF), and transcripts when audio is present
- **Transcripts**: Saved as text files for narrated Loom recordings

**For Loom specifically:** The high-res frames cover the first ~4 seconds; the full-play frames cover the entire video at lower resolution. View both for complete context. If a transcript exists, read it first - it's the most information-dense.

### Step 2c: Assigning an Issue to a Cycle (Sprint)

**There is no `--cycle` flag, and `--data '{"cycleId": …}'` is silently dropped on both
`issues create` and `issues update`** — the CLI accepts it, reports success, and the cycle
stays unset. Setting a cycle is the one common field that only works through the raw
`api mutate` escape hatch. Everything else (state, assignee, priority, description) applies
fine via `-s`/`-a`/`-p`/`-d` on create/update.

Three steps: resolve the cycle ID, run the mutation, verify it stuck.

```bash
# 1. Find the target cycle's ID. Cycles have no names — identify by `number` or date range.
#    "next cycle" = the one whose startsAt is just after today.
linear-cli cycles list -t LLE --output json --compact --no-pager --quiet \
  | jq -c '.cycles[] | {number, id, startsAt, endsAt}'

# 2. Set it via raw GraphQL (id accepts the human identifier like LLE-11602).
#    Use -v KEY=VALUE (repeatable). NOT --variables, NOT a JSON blob.
linear-cli api mutate \
  'mutation($id: String!, $cycleId: String!) {
     issueUpdate(id: $id, input: { cycleId: $cycleId }) {
       success issue { identifier cycle { number startsAt endsAt } }
     }
   }' \
  -v id=LLE-11602 -v cycleId=<CYCLE_UUID> \
  --output json --compact --quiet

# 3. Confirm — the mutation echoes the cycle back, but verify independently too.
linear-cli issues get LLE-11602 --output json --compact --no-pager --quiet \
  | jq -c '{identifier, cycle: (.cycle.number // "NO CYCLE")}'
```

The same `api mutate` path is the fallback for any field the typed subcommands don't
expose — pass its GraphQL variable names, not the CLI flag names.

### Step 3: Present Results Clearly

When showing results to the user:
- Summarize counts: "You have 5 issues in progress, 3 in backlog"
- Highlight urgent/high priority items
- Include issue identifiers (e.g., LIN-123) so they can reference them
- Group by status or team when showing multiple issues
- For sprint status, show progress percentage and days remaining

### Step 4: Handle Errors

If `linear-cli` fails:
1. Check auth: `linear-cli doctor` to diagnose
2. Check team key: teams are LEG, LLEV, DES, EDU, FDE, LLE
3. Retry with `--retry 2` for transient network errors
4. If an issue ID isn't found, try searching: `linear-cli search issues "query"`

### Agent Scripting Gotchas

- Avoid piping `linear-cli` output to commands that may exit early, such as `head`, because the Rust CLI can panic on a broken stdout pipe. Prefer `--limit`, `--fields`, or parse the full JSON output with `jq`.
- When using `jq` fallback expressions, include spaces around the optional field operator and fallback operator: `(.displayName? // "")`, not `(.displayName?//"")`. The latter is parsed as an invalid token by some jq versions.
- Setting a **cycle** on an issue does not work via `--cycle` (no such flag) or via
  `--data '{"cycleId": …}'` (silently ignored on create and update). Use the raw
  `api mutate` recipe in **Step 2c**. All other fields apply normally through
  `-s`/`-a`/`-p`/`-d`.
- For user lookup, prefer this safe pattern:

```bash
linear-cli users list --output json --compact --no-pager --quiet --fields id,name,email,displayName \
  | jq -r '.[] | select(((.name // "") | test("Gabriel"; "i")) or ((.displayName? // "") | test("Gabriel"; "i")) or ((.email // "") | test("gabriel"; "i")))'
```

## Quick Reference: Common Commands

### Issues
```
linear-cli issues list --mine                     # My issues
linear-cli issues list -t TEAM -s "In Progress"   # Team + status filter
linear-cli issues list --mine --group-by state     # Grouped by status
linear-cli issues get ID                           # Issue details
linear-cli issues create "Title" -t TEAM           # Create
linear-cli issues update ID -s Done                # Update status
linear-cli issues start ID                         # Start (In Progress + assign)
linear-cli issues close ID                         # Mark done
linear-cli issues comment ID -m "text"             # Add comment
linear-cli issues assign ID --assignee me          # Assign to self
```

### Projects
```
linear-cli projects list                           # List projects
linear-cli projects get ID                         # Project details
linear-cli projects create "Name" -t TEAM          # Create project
```

### Sprint / Cycles
```
linear-cli sprint status -t TEAM                   # Current sprint
linear-cli sprint progress -t TEAM                 # Progress bar
linear-cli sprint burndown -t TEAM                 # Burndown chart
linear-cli sprint velocity -t TEAM                 # Velocity history
linear-cli cycles current -t TEAM                  # Current cycle details
linear-cli cycles list -t TEAM                     # List cycles (find IDs by number/date)
# Assign an issue to a cycle: no flag exists — see Step 2c (raw `api mutate`)
```

### Git Integration
```
linear-cli git checkout ID                         # Checkout issue branch
linear-cli git pr ID                               # Create GitHub PR
linear-cli git pr ID --draft                       # Create draft PR
linear-cli context                                 # Current issue from branch
linear-cli done                                    # Mark current branch's issue Done
```

### Search and Filtering
```
linear-cli search issues "query"                   # Full-text search
linear-cli issues list --filter state.name=Done    # Filter by field
linear-cli issues list --filter priority=1          # Urgent only
linear-cli issues list --since -7d                 # Created in last week
linear-cli issues list --label "bug"               # By label
```

### Bulk Operations
```
linear-cli bulk update-state -s Done ID1 ID2       # Bulk status update
linear-cli bulk assign --user me ID1 ID2           # Bulk assign
linear-cli bulk label --add "bug" ID1 ID2          # Bulk label
```

### Other Useful Commands
```
linear-cli notifications list                      # My notifications
linear-cli triage inbox -t TEAM                    # Triage inbox
linear-cli metrics velocity -t TEAM                # Team velocity
linear-cli export issues -t TEAM --format csv      # Export issues
linear-cli whoami                                  # Current user info
linear-cli doctor                                  # Diagnose config
```

## Examples

### Example 1: "What am I working on?"
User says: "What are my current tasks?" or "Show my Linear issues"
Actions:
1. Run `bash scripts/my-issues.sh --json`
2. Parse and summarize: group by status, highlight high-priority items
3. Present a clean summary with issue IDs and titles

### Example 2: "Create a bug ticket"
User says: "Create a bug for the login page not loading"
Actions:
1. Use LLE unless user specifies another team (LEG, LLEV, DES, EDU, FDE)
2. Run: `linear-cli issues create "Login page not loading" -t LLE -l bug -p 2 --output json --compact --no-pager --quiet`
3. Report the created issue ID and link

### Example 3: "Start working on LIN-123"
User says: "I'm going to work on LIN-123"
Actions:
1. Run `bash scripts/start-issue.sh LIN-123`
2. This sets the issue to In Progress, assigns to you, and checks out the git branch
3. Confirm the branch name and issue status

### Example 4: "How's the sprint going?"
User says: "Sprint status for the Llev team"
Actions:
1. Run `bash scripts/sprint-status.sh LLEV`
2. Show progress, days remaining, and incomplete issues

### Example 5: "Look at this issue" (with media)
User says: "Check out LLE-8191" or "What's in this issue?"
Actions:
1. Get issue details: `linear-cli issues get LLE-8191 --output json --compact --no-pager --quiet`
2. Extract all media: `bash scripts/get-issue-context.sh LLE-8191`
3. Parse the JSON output, then Read each image/frame file for visual context
4. If a Loom transcript exists, read the transcript file
5. Summarize the issue including what the screenshots/video show

### Example 6: "I'm done with this issue"
User says: "Mark this issue as done" (while on a feature branch)
Actions:
1. Run `bash scripts/finish-issue.sh`
2. Detects issue from branch name, marks as Done
3. Confirm completion
