# v0 Product Spec — o8 (Historical)

## Product goal

Ship a private v0 that proves this question:

**Can one operator manage a small fleet of agents dramatically better from Cortex IDE than from raw terminals, tmux, or ad hoc dashboards?**

## v0 positioning

Cortex IDE v0 is **not** a full replacement for VS Code, Cursor, or existing agent runtimes.
It is a **control plane** that sits above them.

## Primary user

A power user / founder / technical operator who:

- runs multiple coding agents in parallel
- cares about memory and continuity
- wants approvals, audit, and better operational visibility
- wants to supervise work from desktop and phone

## v0 success criteria

A user should be able to:

1. launch or attach to multiple agents
2. see live state for every agent in one place
3. inspect current work, logs, branches, and diffs
4. steer or interrupt an agent quickly
5. review artifacts and pending approvals
6. understand memory / context / cost pressure
7. continue basic oversight from mobile

## Non-goals for v0

- full code editing parity with VS Code
- complete replacement of existing runtime CLIs
- broad multi-tenant SaaS infra
- external open source release
- polished public brand rollout

## Product surfaces

### 1. Desktop operator surface (primary)
A desktop web app or Electron shell with these regions:

- **Fleet sidebar**
  - list of agents and squads
  - states: idle, running, blocked, waiting, reviewing, failed
  - filters by repo, runtime, task, severity

- **Command center canvas**
  - Hoberman-sphere-inspired fleet map
  - collapsed = high-level squad health
  - expanded = squads, agents, tasks, worktrees, diffs, memory clusters

- **Inspector panel**
  - selected agent details
  - model, context usage, current task, branch, session key, artifacts
  - terminal and last tool output

- **Timeline / review rail**
  - diffs, PRs, messages, approvals, incidents, alerts

- **Top command strip**
  - spawn
  - pause
  - steer
  - assign task
  - approve / deny
  - budget / alerts / cost / token usage

### 2. Mobile operator surface (day-one lightweight)
A paired iOS remote app or responsive mobile shell for:

- push notifications
- live watch mode
- approve / deny actions
- quick steer messages
- run summaries
- PR / diff queue skim
- Cortex recall search
- budget / alert visibility

## Core objects

### Agent
- id
- name
- runtime
- model
- state
- repo/workspace
- branch/worktree
- task
- context pressure
- cost
- memory health
- last event

### Squad
- id
- name
- role
- agents[]
- throughput
- blockers
- budget
- alert count

### Run
- id
- agent_id
- start/end timestamps
- status
- logs
- artifacts
- approvals requested
- memory reads/writes

### Artifact
- diff
- file set
- PR
- issue
- message
- document
- screenshot
- benchmark result

### Memory object
- recall result
- provenance
- confidence
- source scope
- learned policy / lesson / decision

## Core workflows

### Workflow 1 — Start work
1. Operator creates or selects a task
2. Assigns to agent or squad
3. Runtime session starts or attaches
4. Agent appears in fleet map as active
5. Inspector shows live progress

### Workflow 2 — Steer a running agent
1. Operator selects agent
2. Sees latest log / output / diff
3. Sends steer instruction
4. Steer appears in timeline
5. Agent continues with updated intent

### Workflow 3 — Review output
1. Agent completes work or requests review
2. Diff / PR / artifact enters review rail
3. Operator inspects summary and raw diff
4. Approve, reject, request change, or route to another agent

### Workflow 4 — Resolve blocker
1. Agent enters blocked/error state
2. Alert appears in desktop + mobile
3. Operator opens incident context
4. Cortex surfaces relevant memories / prior fixes
5. Operator resumes, reroutes, or terminates run

### Workflow 5 — Mobile intervention
1. Push notification fires: approval needed / run complete / blocker
2. Operator opens phone app
3. Sees summary, affected repo, cost/context, and key evidence
4. Approves, denies, or steers without opening laptop

## v0 feature list

### Must have
- multi-agent roster and live state
- runtime attach / spawn / stop / steer
- terminal/log inspection
- task + run timeline
- Git branch / worktree visibility
- diff preview
- approval queue
- Cortex recall panel
- cost / token / context meters
- mobile notifications + quick actions

### Should have
- squad grouping
- saved views / filters
- recent artifacts list
- memory health and provenance indicators
- run replay / audit mode
- GitHub PR linkouts

### Nice to have
- voice interaction on mobile
- auto-suggested reroutes
- workload balancing recommendations
- agent scorecards / trend analytics

## Recommended v0 stack

### UI
- Next.js or similar web app for speed
- optional Electron wrapper later if needed
- native iOS client or SwiftUI thin client for mobile

### Backend / orchestration
- Node/TypeScript control service
- event bus for runs, logs, approvals, and alerts
- runtime adapters for OpenClaw / ACP / CLI agents

### Memory
- Cortex as first-class service
- recall API
- provenance API
- memory health / write logs

### Storage
- SQLite or Postgres for runs, events, artifacts, approvals
- object store / filesystem for attachments and screenshots

## Why v0 should not start as a VS Code fork

A VS Code fork would front-load too much complexity:

- editor parity pressure
- extension compatibility issues
- distribution overhead
- distraction from proving the actual wedge

v0 should prove the control plane first.
If that works, VS Code integration or fork can happen later.

## Proposed v0 milestones

### Milestone 1 — single-machine control tower
- attach to multiple local/desktop agents
- show live state + logs + steer
- basic Cortex recall panel

### Milestone 2 — review and audit loop
- diffs, PR queue, approvals, artifacts
- incident and blocker handling
- replayable run history

### Milestone 3 — mobile remote control
- pairing
- notifications
- approve / deny / steer
- Cortex search and status on phone

### Milestone 4 — squad and org views
- Hoberman collapse/expand fleet map
- squad budgets / blockers / throughput
- org templates and reusable layouts

## Open questions

1. Should v0 be web-first only, or should mobile ship in parallel?
2. What is the first runtime adapter to make truly great?
3. How deeply should GitHub live inside the product vs link out?
4. How much of Cortex should be directly editable from the UI vs surfaced read-mostly?
5. What minimum set of mobile actions are truly worth day-one complexity?

## v0 recommendation

Build v0 as a **desktop-first control plane with a real mobile remote companion**.
That is the sharpest expression of the thesis without getting trapped in editor rebuild work too early.
