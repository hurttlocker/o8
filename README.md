# Cortex IDE

Private working repo for the **Cortex IDE** concept.

## What this is

Cortex IDE is a thesis for an **agent-native development environment**:

- the unit of work is not just a file, but an **agent**
- the product is not just an editor, but an **agent command center**
- memory is not an afterthought, but a first-class **operating system primitive**
- mobile is not a bolt-on viewer, but a **remote control surface** for approval, monitoring, and steering

This repo captures the initial company thesis, v0 product spec, system architecture, mobile strategy, and research notes from the first design sprint.

## Current position

### Core belief
The next big developer product may not be another autocomplete-heavy editor.
It may be the best place to **run, supervise, steer, and scale teams of coding agents**.

### Initial wedge
Start as a **multi-agent control plane** that works across existing runtimes.
Do **not** begin as a full VS Code fork.

### Working product framing
- **Cortex** = memory and continuity substrate
- **OpenClaw / ACP runtimes** = execution substrate
- **Git / GitHub / worktrees / terminals** = software delivery substrate
- **Cortex IDE** = operator surface that makes all of it legible and steerable

### Mobile view
Mobile support should likely exist from day one, but as a **remote operator surface**, not a full mobile IDE.
The right model is:

- desktop does the heavy lifting
- phone handles approvals, status, notifications, quick steering, Cortex recall, and diff review

## Repo map

- `docs/company-thesis.md` — why this company should exist
- `docs/v0-product-spec.md` — first shipping surface and user flows
- `docs/v1-build-plan.md` — v1 plan grounded in Karpathy’s command-center requirements
- `docs/system-architecture.md` — system map and where Cortex / OpenClaw / Paperclip fit
- `docs/mobile-strategy.md` — day-one mobile thesis and architecture
- `docs/roadmap.md` — phased build sequence
- `docs/issue-map.md` — epic lanes and issue structure
- `docs/remodex-integration-plan.md` — how to use the Remodex/Phodex lane without letting it define the whole product
- `docs/research/x-thread-notes.md` — notes from the Karpathy + Remodex threads
- `assets/mockups/` — early visual directions

## Initial product stance

### What it is not
- not just a prettier tmux grid
- not just another chat pane inside VS Code
- not just a memory plugin
- not just Paperclip renamed

### What it could become
- the **Cursor for agent organizations**
- the **control tower for 5–50 agents**
- the place where memory, execution, review, and approvals become one system

## Near-term recommendation

1. Prove the wedge as a **standalone command center** first
2. Add desktop + mobile operator surfaces
3. Integrate Cortex deeply as the memory and audit substrate
4. Consider VS Code distribution later only if the control plane is already clearly valuable

## Status

Drafted on 2026-03-11.
Private repo only for now.
