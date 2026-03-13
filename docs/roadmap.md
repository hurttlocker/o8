# Roadmap — Cortex IDE

## Guiding rule

Roadmap is ordered by **wedge strength**, not by visual polish.

The product wins if it becomes the best way to operate an agent organization.
Not if it becomes the prettiest speculative IDE mockup.

A second rule now matters just as much:
- keep the **chat page** as the fluent front door
- let deeper runtime and org-control layers unfold progressively behind it

## Phase 0 — Lock the thesis and architecture

### Outcome
The company thesis, architecture, and v1 boundaries are explicit.

### Deliverables
- company thesis
- v0 spec
- v1 build plan
- system architecture
- mobile strategy
- issue map + epics

### Exit criteria
- clear v1 scope
- clear no-fork-first decision
- clear Remodex/Phodex adaptation stance
- clear Cortex role in the stack

## Phase 1 — Command center shell

### Outcome
A real desktop shell for supervising multiple agents.

### Deliverables
- desktop app shell
- fleet sidebar
- top command strip
- inspector panel
- timeline / event rail
- run-state model
- basic saved views

### Exit criteria
- operator can see 5+ agents in one UI
- agent states are trustworthy
- related tools open from context

## Phase 2 — Runtime and review loop

### Outcome
Cortex IDE can actually manage software work, not just display it.

### Deliverables
- runtime adapters
- spawn / attach / steer / pause / kill
- terminal/log streaming
- branch / worktree visibility
- diff preview
- GitHub PR / issue linkage
- approval queue

### Exit criteria
- operator can launch and supervise real agent work
- operator can review outputs without leaving the product for basic flows

## Phase 3 — Cortex-native memory layer

### Outcome
Memory becomes visible and operational.

### Deliverables
- Cortex recall panel
- provenance surfaces
- memory health indicators
- run replay context
- prior-fix / prior-decision surfacing
- org learning hooks

### Exit criteria
- blocked runs can surface relevant prior context
- operator can understand why an agent did something
- continuity is visibly better than stateless control tools

## Phase 4 — Mobile remote control

### Outcome
The operator can meaningfully manage the system away from desktop.

### Deliverables
- pairing flow
- notifications
- approvals
- steer messages
- live run watch
- alert inbox
- Cortex mobile recall

### Exit criteria
- operator can resolve a real approval or blocker from phone
- mobile meaningfully reduces “must-open-laptop-now” moments

## Phase 5 — Org code and scaling patterns

### Outcome
Cortex IDE moves from “run many agents” to “run reusable agent organizations.”

### Deliverables
- squad templates
- policy packs
- reusable assignment/review flows
- org presets
- per-squad analytics and budgets

### Exit criteria
- teams / layouts / flows become forkable
- product starts to feel like a system for agent organizations, not individual runs

## Phase 6 — Optional spatial / topology views

### Outcome
Explore higher-bandwidth visualization only after the command center is already good.

### Deliverables
- topology view
- optional Hoberman-sphere-inspired compression model
- alternative graph / map views

### Exit criteria
- topology improves speed or comprehension
- no regression to core legibility

## What is intentionally not first

- landing page polish
- open-source packaging
- VS Code fork
- heavy branding work
- cinematic visualization for its own sake

## Current recommendation

Build through **Phase 4** before making any serious call on:
- full VS Code fork
- public launch shape
- whether the Hoberman interaction deserves to be the signature UI
