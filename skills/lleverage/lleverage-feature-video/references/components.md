# Product UI catalogue

What `ui/components.js` rebuilds, with the source component and the exact copy. Paths are in the lleverage repo
(`apps/app/src/components/...` unless stated). Re-check a component against its source when the screen changes, and
add every new builder here with its path and copy.

## Shell

| Builder | Source | Notes |
| --- | --- | --- |
| `UI.sidebar(active, project)` | `sidebar-nav`, `platform-nav-item` | Pinned: Agent, Overview, Requests, Workflows, Skills, Data tables, Monitoring; Project: Knowledge, Apps. Active item `bg-border`. Logo is the kit ident |
| `UI.loader(size)`, `UI.drive(el, mode, t)` | `lleverage-loader.tsx` | 7×7 mark; modes `working`, `agent`, `listening` |

## Agent chat

| Builder | Source | Copy and styling |
| --- | --- | --- |
| `UI.chat(id, msgs, {extra, overlay})` | `agent/agent-chat.tsx` | Agent page: sidebar plus a centred chat column; composer placeholder "Ask the agent anything…", model label e.g. "Opus 5.5" |
| `UI.user(id, text)` | `agent-chat.tsx:1355–1419` | Right-aligned, `max-w-[80%]`, bubble `rounded-xl bg-muted px-2 py-1.5 text-sm` |
| `UI.assistant`, `UI.step(id, faIcon, text)` | `agent-chat.tsx` | Prose `text-sm`; tool steps muted with a 16px icon dot |
| `UI.setStatus(el, label, secs, t)` | `agent/agent-status-indicator.tsx` | Labels: "Stand by", "Thinking", "Using a tool", "Responding", "Waiting for you", "Done", "Something went wrong". Active in `text-highlight` with the loader; "· 12s"; "Stop" is an underlined text link |
| `UI.pending(id, rows)` | `agent/queued-messages-list.tsx:350–445` | With steering on: "1 message waiting for the agent's next step" / "N messages waiting for the agent's next step"; rows keep "Send now" (arrow up) and discard (x); no reorder, edit or "Send together" |
| `UI.attachment(name, type)` | `workflow-app/elements/composer-attachment-cards.tsx`, `requests/attachment-cards.tsx` | 128×128 squares, `rounded-xl border`, file name `text-[11px] font-medium`, uppercase type pill bottom-left; no size, no type icon |
| `UI.limitToast(id, n)` | `agent/agent-chat.tsx:3889–3896`; copy in `packages/data/src/agent-message-attachments.ts` | "1 attachment wasn't added" / "N attachments weren't added"; "You can add up to 50 files to one message. Remove some, or send the rest in a follow-up message." |
| `UI.subagent(id, task, result)`, `UI.subagentState(id, t, doneAt, open)` | `agent/subagent-activity-card.tsx` | Header: lucide bot, status icon, the task (truncated), chevron. Working = spinning `faCircleNotch`, completed = `faCircleCheck` green. Expanded: "Assigned task", "Result" (also "Latest activity", "Error"). The card does not show the role (explore, plan, ...) |

## Workflow canvas

| Builder | Source | Notes |
| --- | --- | --- |
| `UI.node(id, x, y, {icon, color, ref, desc})` | `workflow/node/basic-node.tsx`, `node-header.tsx`, `node-ref-pill.tsx` | Ref pill with a coloured icon circle, description below; handles left and right |
| node names, icons and colours | `workflow/node/node-icon.tsx` | Agent: `s:faRobot`, `node-coral`. Branch (not "If/Else"): `s:faCodeBranch`, `node-sky`. Request Decision (the legacy approval node; the newer one is "Request"): `s:faUserCheck`, `node-mauve`. Triggers: `node-plum`; integration triggers show the logo, e.g. "Outlook: New Email Received" with `UI.integration("microsoft-outlook")` |
| `UI.edges`, `UI.nodeIn`, `UI.edgeIn` | React Flow bezier | Edges from source to target handle; nodes land with a short scale and a selection ring |

"Write Project File" exists as an action (`packages/actions-common/src/actions/project-file-platform.ts`), but its
canvas node was not mapped yet.

## Workflow apps

| Builder | Source | Copy |
| --- | --- | --- |
| `UI.responseCard(id, {title, status, fields, by})` | `workflow-app/response-corrections/session-response-corrections.tsx:284–326` | Bottom strip `bg-muted`; right-aligned outline button "Edit and resubmit" with `faPenToSquare` |
| `UI.resubmitDialog(id, title)` | same | "Edit and resubmit “<title>”?"; "This creates a new response prefilled with your latest answers. Your earlier response stays in the session as it is."; "Cancel", "Create new response" |

## Not yet mapped (worth adding next)

The Overview and its widgets, data tables (grid, Kanban, Cards), the request view, the skills pages, the voice call
pill, the Agent on the workflow canvas. Badr's `create-feature-video` templates in `lleverage-ai/plugins-internal`
(`talk-to-llev`, `kanban-board`, `skill-tests`, `invite-dialog`, `agent-setup`) are good starting points for their
markup; port them as builders here.
