# Cortex IDE Epic: Import Cline Kanban Functionality Natively

Date: 2026-03-26

## Research Snapshot

The published package is `kanban@0.1.45`.

- License: Apache-2.0
- Repo: `https://github.com/cline/kanban`
- NPM: `https://www.npmjs.com/package/kanban`
- Tarball size: about 3.1 MB
- Unpacked size: about 13.6 MB
- File count: 308
- Node requirement: `>=20`

It is not Electron.

- The published package is a Node CLI with a local browser app.
- The CLI binary is `kanban`.
- It serves a bundled web UI from a local HTTP server.
- It opens the app in the browser.
- It uses `node-pty`, `ws`, and `@trpc/server`.
- The web app is React 18 + Vite + Tailwind 4 + Radix + xterm + `@hello-pangea/dnd`.

Notable packaged payload sizes:

- `dist/web-ui/assets/index-DoNpUoGJ.js`: about 2.3 MB
- `dist/web-ui/assets/xterm-vendor-x1-S2SBl.js`: about 623 KB
- `dist/web-ui/assets/index-Dh6GANSR.css`: about 56.5 KB

## Decision

Do not embed Cline Kanban wholesale into Cortex IDE.

Reasons:

- It is tightly coupled to `@clinebot/agents`, `@clinebot/core`, and `@clinebot/llms`.
- It carries its own PTY runtime, hook ingestion, workspace registry, tRPC API, and browser server.
- It assumes a separate local web app instead of integrating into an existing shell.
- Importing it directly would duplicate Cortex runtime adapters, state, worktree management, and review surfaces.
- The user-facing functionality is worth importing. The architecture is not.

Recommended approach:

- Rebuild the Kanban capability set inside Cortex’s existing shell.
- Reuse Cortex primitives where they already exist.
- Borrow only interaction patterns, state rules, and selected algorithms from Cline Kanban.
- Keep Cortex runtime-agnostic and mobile-aware.

## What Kanban Actually Ships

Based on the source and package contents, the product is more than a board.

- Board columns: `backlog`, `in_progress`, `review`, `trash`
- Dependency links between tasks
- Manual task creation and batch creation
- Task creation through a sidebar board-manager chat
- Base ref per task
- Start in plan mode toggle
- Auto-review automation: `commit`, `pr`, `move_to_trash`
- Task-specific worktrees
- Symlink mirroring of ignored paths like `node_modules`
- Patch capture for trashed task worktrees
- PTY-backed task sessions for multiple agent CLIs
- Hook-based live activity summaries per card
- Card detail split view with terminal, diff, file tree, and chat
- Diff modes for full working copy vs last turn
- Diff line comments sent back to the agent
- Git history and home branch controls
- Project navigation across tracked repos
- Runtime settings and onboarding
- Script shortcuts in the navbar
- Browser review-ready notifications
- Prewarmed terminals

Primary source anchors in the Kanban repo:

- `README.md`
- `src/core/api-contract.ts`
- `src/core/task-board-mutations.ts`
- `src/workspace/task-worktree.ts`
- `src/terminal/session-manager.ts`
- `src/server/runtime-server.ts`
- `web-ui/src/App.tsx`
- `web-ui/src/hooks/use-board-interactions.ts`
- `web-ui/src/hooks/use-review-auto-actions.ts`
- `web-ui/src/hooks/use-task-start-actions.ts`
- `web-ui/src/hooks/use-git-actions.ts`
- `web-ui/src/components/card-detail-view.tsx`
- `web-ui/src/components/dependencies/use-dependency-linking.ts`
- `web-ui/src/components/top-bar.tsx`

## Existing Cortex Reuse Points

Cortex already has a meaningful amount of the underlying substrate.

- Dormant timeline drilldown and connected issue/session sidecars already exist in `src/components/desktop/SessionTimeline.tsx`.
- Workflow dependency and waiting states already exist in `src/lib/workflows/types.ts` and `src/lib/workflows/templates/sentry-triage-pr.ts`.
- Worktree lifecycle exists in `src/lib/worktree/manager.ts`.
- Review surface exists in `src/components/workflow-review-panel.tsx`.
- PR / merge / discard endpoints already exist in `src/app/api/worktrees/merge/route.ts`.
- IDE-owned Codex launch, resume, and interrupt already exist in `src/components/command-center-shell.tsx` and `src/lib/codex/owned.ts`.
- Mobile worktree actions already exist in `src/components/mobile/WorktreeActions.tsx`.

This means the correct strategy is not “build Kanban from zero.”

The correct strategy is:

- promote existing Cortex control-plane primitives into a first-class board
- add the missing UI and state layers
- normalize agent, worktree, diff, and issue state around tasks

## Epic Goal

Build a Cortex-native board surface that matches the useful functionality of Cline Kanban while remaining:

- runtime-agnostic
- embedded in the existing Cortex shell
- compatible with owned and discovered sessions
- wired into mobile review and action flows
- consistent with Cortex’s review rail, timeline, memory, and operator model

## Epic Non-Goals

- Do not ship a second standalone local web server as the primary Cortex UX.
- Do not import `@clinebot/*` as the control plane.
- Do not regress Cortex into a Cline-only product.
- Do not make mobile an afterthought.
- Do not duplicate existing review and worktree implementations unless replacement is intentional.

## Proposed Epic

Epic title:

`feat: Cortex native board for multi-agent task orchestration`

Epic success criteria:

- Operators can create, link, launch, pause, review, ship, and trash multi-agent tasks from a board.
- Each task can own a runtime session and an isolated worktree.
- Tasks can auto-chain through dependency completion.
- Review can happen inside Cortex with terminal, diff, comments, and Git actions.
- Desktop and mobile both surface review-ready work.
- The board uses existing Cortex runtime and review infrastructure instead of bypassing it.

## Issue Breakdown

### Issue 1: Define the Cortex Board Domain Model and Persistence Layer

Problem:

Kanban’s board state is explicit. Cortex has worktrees, sessions, reviews, and workflow stages, but no canonical board state that binds them together.

Scope:

- Define a Cortex task entity separate from ad hoc session labels.
- Define board columns and transitions.
- Define dependency edges.
- Define per-task automation settings.
- Define per-task issue linkage.
- Define revisioned persistence and conflict handling.

Deliverables:

- `src/lib/board/types.ts`
- `src/lib/board/state.ts`
- `src/app/api/board/*`
- persistence keyed by workspace / repo

Acceptance criteria:

- Board state persists across refreshes and app restarts.
- Concurrent writes are revision-safe.
- Tasks support `backlog`, `in_progress`, `review`, `trash`.
- Tasks support dependency edges and automation config.
- Tasks can be associated with runtime surface IDs, worktree IDs, issue IDs, and PR IDs.

Dependencies:

- none

Notes:

- Reuse concepts from `src/core/api-contract.ts` in Kanban.
- Do not reuse Cline schemas directly.

### Issue 2: Turn Timeline Drilldown into the Cortex Board Shell

Problem:

Cortex already has the interaction foothold for this surface, but it is disabled.

Scope:

- Re-enable the double-click drilldown from the timeline.
- Replace the legacy drill surface with a real board shell.
- Preserve current design language from `BRAND.md`.
- Support opening the board from desktop shell and canvas surfaces.

Deliverables:

- board shell mounted from `src/components/desktop/SessionTimeline.tsx`
- board canvas tab integration
- navigation state for selected task and selected column

Acceptance criteria:

- Double-click on timeline opens the board.
- Existing connected sidecar concepts become task detail panels rather than orphan drill panels.
- No mock or placeholder task state is shown.

Dependencies:

- Issue 1

Reuse anchors:

- `src/components/desktop/SessionTimeline.tsx`
- `src/components/desktop/Canvas.tsx`

### Issue 3: Add Task Composer, Batch Creation, and Task Metadata Editing

Problem:

Kanban supports quick task entry, batch task creation, plan-mode toggles, base refs, images, and automation flags. Cortex needs a first-class task composer instead of treating every launch as freeform runtime input.

Scope:

- Task create dialog
- Inline create card
- Batch create from multiline prompts
- Start-in-plan-mode toggle
- Base ref selector
- Auto-review toggle and mode
- Optional issue association
- Optional image/context attachments

Deliverables:

- `src/components/desktop/BoardTaskComposer.tsx`
- `src/components/desktop/BoardInlineCreateCard.tsx`
- board mutation handlers

Acceptance criteria:

- Operator can create one or many tasks.
- Task metadata can be edited after creation.
- Task create and create+start both work.
- Task composer supports issue linkage and base branch selection.

Dependencies:

- Issue 1

Reuse anchors:

- `src/components/desktop/IssueLinkPicker.tsx`
- `src/components/desktop/IssueCreator.tsx`
- `src/components/mobile/LaunchSheet.tsx`

### Issue 4: Implement Dependency Graph Overlay and Linking Interactions

Problem:

The card linking interaction is one of the most useful parts of Kanban and maps directly to Cortex’s dormant “hold” idea.

Scope:

- Ctrl/Cmd drag or click-to-link interactions
- Render dependency arrows across columns
- Delete dependency edges
- Enforce valid link rules
- Map “on hold” into explicit dependency-gated backlog semantics

Deliverables:

- dependency overlay component
- dependency interaction hook
- board validation rules

Acceptance criteria:

- Operators can create and remove task links visually.
- Invalid links are rejected with clear messages.
- Trashed prerequisite tasks unlock dependent backlog tasks.
- Board state exposes which backlog tasks are startable now.

Dependencies:

- Issue 1
- Issue 2

Reuse anchors:

- `src/lib/workflows/types.ts`
- `src/lib/workflows/templates/sentry-triage-pr.ts`

Borrowed logic anchors:

- `web-ui/src/components/dependencies/use-dependency-linking.ts`
- `src/core/task-board-mutations.ts`
- `web-ui/src/hooks/use-linked-backlog-task-actions.ts`

### Issue 5: Bind Board Tasks to Real Runtime Sessions Across Adapters

Problem:

A Cortex task must be able to own a real session, not just point at a transcript after the fact.

Scope:

- Add board-aware session launch across Codex, Claude Code, OpenClaw, and shell lanes.
- Bind runtime surface IDs to board task IDs.
- Support start, stop, interrupt, resume, and reattach.
- Distinguish owned vs discovered runtimes cleanly.

Deliverables:

- runtime adapter board launch contract
- board task session controller
- session-to-task registry

Acceptance criteria:

- Starting a task creates or attaches a truthful runtime session.
- Owned Codex resume and interrupt flows work from the board.
- Runtime state changes update board cards in real time.
- Discovered sessions never pretend to be fully mutable if they are not.

Dependencies:

- Issue 1

Reuse anchors:

- `src/components/command-center-shell.tsx`
- `src/lib/codex/owned.ts`
- `src/lib/runtime/adapter.ts`

### Issue 6: Reach Worktree Parity for Task-Scoped Execution

Problem:

Cortex already has worktrees, but Kanban’s task-scoped workflow adds extra behavior: automatic path mirroring, resumability after trash, and stronger task/worktree coupling.

Scope:

- Extend worktree metadata to treat board task as first-class owner
- Add ignored-path mirroring parity where safe
- Add patch capture or resumable artifact on trash
- Tighten cleanup semantics for task disposal
- Add worktree warnings when local-only state would be lost

Deliverables:

- worktree metadata changes
- optional ignored-path mirroring rules
- resume-from-trash design

Acceptance criteria:

- Starting a task creates or reuses a worktree tied to the task.
- Trashing a task cleans up the worktree with safe warnings.
- PR / merge / discard flows remain intact.
- Worktree metadata can reconstruct task context after refresh.

Dependencies:

- Issue 1
- Issue 5

Reuse anchors:

- `src/lib/worktree/manager.ts`
- `src/app/api/worktrees/merge/route.ts`
- `src/components/mobile/WorktreeActions.tsx`

Borrowed logic anchors:

- `src/workspace/task-worktree.ts`

### Issue 7: Add Live Card Telemetry, Hook Activity, and Review-Ready State

Problem:

Kanban cards are useful because they show the latest meaningful thing each agent did without opening the detail panel.

Scope:

- Surface latest task activity on each card
- Show tool calls, latest message, state, warnings, and timestamps
- Show review-ready state, failure state, and blocked/waiting state
- Integrate card state with notifications

Deliverables:

- card summary model
- live activity reducers
- state badges and time labels

Acceptance criteria:

- Board cards update as sessions stream.
- Review-ready cards are visually distinct.
- Failed or blocked sessions read clearly at a glance.
- Mobile can consume the same summary model.

Dependencies:

- Issue 5

Reuse anchors:

- `src/lib/chat/sidebar-events.ts`
- `src/lib/alerts/engine.ts`
- `src/components/mobile/ActivityFeed.tsx`

Borrowed logic anchors:

- `src/commands/hooks.ts`
- `src/core/api-contract.ts`

### Issue 8: Build the Task Detail Workspace View

Problem:

The board is only valuable if clicking a task opens a serious workspace, not a toy preview.

Scope:

- Task detail view with terminal panel
- File tree
- Diff viewer
- Agent chat / steering panel
- Expand / collapse / split pane behavior
- Bottom pane terminal support

Deliverables:

- Cortex board detail view
- panel state model
- diff mode toggle

Acceptance criteria:

- Clicking a task opens a rich detail workspace.
- Operator can steer the task from inside the detail view.
- Diff and terminal remain synchronized with task state.
- Layout handles large diffs and long-running terminals without breaking.

Dependencies:

- Issue 5
- Issue 7

Reuse anchors:

- `src/components/desktop/WorkspaceTerminal.tsx`
- `src/components/desktop/AgentPanelChat.tsx`
- `src/components/desktop/WorkspaceSidePanel.tsx`
- `src/components/desktop/DiffModal.tsx`

Borrowed logic anchors:

- `web-ui/src/components/card-detail-view.tsx`

### Issue 9: Add Last-Turn Checkpoints and Inline Diff Comment Feedback

Problem:

Kanban distinguishes “all changes” from “last turn” and lets the operator comment directly on diff lines back to the agent. That closes the review loop.

Scope:

- Add task review checkpoints per turn
- Support working-copy diff and last-turn diff
- Add inline diff comments
- Turn diff comments into agent feedback payloads

Deliverables:

- checkpoint store
- diff mode selector
- line comment draft model
- send-comments flow into board-owned sessions

Acceptance criteria:

- Operator can switch between all changes and last turn.
- Line comments can be drafted and sent.
- Comments reach the runtime in a deterministic way.
- Checkpoints survive refresh and session reconnect.

Dependencies:

- Issue 5
- Issue 8

Reuse anchors:

- `src/components/desktop/WorkspaceTerminal.tsx`
- `src/components/desktop/AgentPanelChat.tsx`
- `src/lib/codex/owned.ts`

Borrowed logic anchors:

- `src/workspace/turn-checkpoints.ts`
- `web-ui/src/components/detail-panels/diff-viewer-panel.tsx`

### Issue 10: Implement Auto-Commit, Auto-PR, Auto-Trash, and Dependency Auto-Start

Problem:

This is the core “autonomy” layer in Kanban. Without it, Cortex only gets a board, not orchestration.

Scope:

- Add per-task auto-review settings
- Detect when review tasks have meaningful changes
- Trigger commit or PR action automatically
- Auto-trash after successful ship when configured
- Auto-start dependent tasks when prerequisites are trashed or completed

Deliverables:

- automation state machine
- review automation guardrails
- dependency-triggered backlog starter

Acceptance criteria:

- Auto-commit only fires when review has real changes.
- Auto-PR only fires once per armed review state.
- Auto-trash only happens after safe completion conditions.
- Ready dependent tasks auto-start in the intended order.

Dependencies:

- Issue 4
- Issue 6
- Issue 9

Reuse anchors:

- `src/app/api/worktrees/merge/route.ts`
- `src/components/mobile/WorktreeActions.tsx`

Borrowed logic anchors:

- `web-ui/src/hooks/use-review-auto-actions.ts`
- `web-ui/src/hooks/use-linked-backlog-task-actions.ts`

### Issue 11: Add a Cortex Git Surface for Home Branch and Task Worktrees

Problem:

Kanban’s top bar and git history reduce context switching. Cortex already has git data in several places but not as one operator surface for board work.

Scope:

- Show current branch and diff counts in the board header
- Fetch, pull, push
- Home branch switch and discard
- Git history view for home repo and task-scoped worktrees
- Open target shortcuts for file paths and branches

Deliverables:

- board top bar git status
- git history panel
- home repo actions

Acceptance criteria:

- Operator can inspect home git state from the board.
- Operator can inspect task worktree history from the detail view.
- Branch and diff counts update after actions.

Dependencies:

- Issue 6
- Issue 8

Reuse anchors:

- `src/components/desktop/RepoRegistrySection.tsx`
- `src/components/desktop/WorkspaceSidePanel.tsx`
- `src/components/workflow-review-panel.tsx`

Borrowed logic anchors:

- `web-ui/src/hooks/use-git-actions.ts`
- `web-ui/src/components/top-bar.tsx`

### Issue 12: Add a Board Manager Agent and Issue-to-Task Linking

Problem:

The board becomes much more useful when the operator can ask for decomposition, linking, and launch from a manager lane rather than manually creating every card.

Scope:

- Add a board-manager chat lane
- Allow it to create tasks, edit tasks, link tasks, and start tasks
- Connect board tasks to GitHub issues and issue creation
- Keep manager lane distinct from implementation lanes

Deliverables:

- board manager tool layer
- task mutation command surface
- issue linkage model

Acceptance criteria:

- Operator can ask Cortex to break a goal into tasks.
- The manager lane can build dependency chains.
- Tasks can link to existing or newly created issues.
- Manager lane never impersonates an implementation agent.

Dependencies:

- Issue 1
- Issue 3
- Issue 4

Reuse anchors:

- `src/components/desktop/ThoughtsCard.tsx`
- `src/components/desktop/IssueCreator.tsx`
- `src/components/desktop/IssueLinkPicker.tsx`

Borrowed logic anchors:

- `src/prompts/append-system-prompt.ts`

### Issue 13: Wire Board Events into Desktop Alerts and Mobile Remote Control

Problem:

Cortex’s differentiation is not just desktop boarding. It is operator continuity across phone and desktop.

Scope:

- Desktop notifications for review-ready and blocked tasks
- Mobile inbox and quick actions for board tasks
- Mobile open-task, review, PR, merge, discard, resume, interrupt
- Shared task summary model for desktop and phone

Deliverables:

- board notifications layer
- mobile board task payloads
- task action routing from mobile

Acceptance criteria:

- Review-ready tasks alert correctly.
- Mobile can open and act on board tasks.
- Mobile actions are truthful for each runtime capability.

Dependencies:

- Issue 5
- Issue 7
- Issue 10

Reuse anchors:

- `src/components/mobile/WorktreeActions.tsx`
- `src/app/api/mobile/action/route.ts`
- `src/lib/mobile/openclaw.ts`
- `src/lib/alerts/engine.ts`

### Issue 14: Add Runtime Settings, Shortcuts, and Onboarding for Board Operators

Problem:

Kanban includes shortcuts, runtime config, notifications, and startup onboarding because the orchestration surface needs fast setup and repeat actions.

Scope:

- Board-specific settings section
- Script shortcuts
- Runtime selection defaults
- Notification permission flow
- Task default settings
- “start here” onboarding for first-time board users

Deliverables:

- board settings panel
- shortcut registry integration
- onboarding flow

Acceptance criteria:

- Operators can configure favorite script shortcuts.
- Operators can set default runtime, default branch behavior, and automation defaults.
- First-run board onboarding leads to successful first task start.

Dependencies:

- Issue 3
- Issue 5

Reuse anchors:

- `src/components/desktop/SettingsPage.tsx`
- `src/components/mobile/SettingsView.tsx`

Borrowed logic anchors:

- `web-ui/src/components/runtime-settings-dialog.tsx`
- `web-ui/src/components/startup-onboarding-dialog.tsx`

### Issue 15: Hardening, Performance, Telemetry, and Migration

Problem:

A board that only works with 5 cards is a demo, not an operator surface.

Scope:

- Stress test with 50, 100, and 200 task cards
- Virtualize heavy lists and logs
- Prevent terminal/socket explosion
- Track board usage, starts, dependency edges, and automation outcomes
- Add regression coverage for board state and drag rules

Deliverables:

- test suite
- performance budget
- telemetry schema
- launch checklist

Acceptance criteria:

- Board remains usable with large task counts.
- No runaway websocket or terminal attachment growth.
- Drag, dependency, and auto-review flows have regression coverage.
- Telemetry captures board adoption and failure modes.

Dependencies:

- all previous issues

Reuse anchors:

- `docs/performance-architecture-principles.md`
- existing desktop and mobile hooks tests

Borrowed logic anchors:

- Kanban’s `web-ui/src/state/*.test.ts`
- Kanban’s `web-ui/src/hooks/*.test.ts*`

## Recommended Sequence

Phase 1:

- Issue 1
- Issue 2
- Issue 3
- Issue 4

Phase 2:

- Issue 5
- Issue 6
- Issue 7

Phase 3:

- Issue 8
- Issue 9
- Issue 10
- Issue 11

Phase 4:

- Issue 12
- Issue 13
- Issue 14
- Issue 15

## Import Strategy

What to borrow directly as ideas or algorithms:

- dependency edge rules
- startable backlog logic
- auto-review state machine
- worktree trash patch capture concept
- split-pane detail workspace interaction model
- git history panel behavior
- shortcut and onboarding ergonomics

What not to borrow directly:

- separate local runtime server
- `@clinebot/*` runtime stack
- Cline hook assumptions as the core control plane
- browser-first app shell that sits outside Cortex

## Bottom Line

The opportunity is real.

Cline Kanban did not invalidate Cortex IDE. It validated a missing Cortex surface:

- task-centric orchestration above terminals
- explicit dependency state
- task detail review workspaces
- automation from review to ship

The fastest winning move is to import the capability set into Cortex’s existing desktop shell, runtime adapters, review rail, worktree system, and mobile control lane.
