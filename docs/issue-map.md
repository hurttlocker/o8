# Issue Map — Cortex IDE v1

## Structure

We will use:
- **epics** for major product lanes
- **issues** for bounded execution slices

## Epic lanes

### Epic A — Command center core
Purpose: deliver Karpathy’s “bigger IDE / agent command center” baseline.

Child slices:
- desktop shell
- fleet state model
- live agent roster and status
- inspector + tool drawers
- timeline / event rail
- saved views and focus modes

### Epic B — Runtime adapters and software-workflow surfaces
Purpose: make the control plane manage real work.

Child slices:
- runtime adapter contract
- OpenClaw / ACP session adapter
- terminal/log stream surface
- Git / worktree surface
- GitHub PR / issue linkage
- review / approval actions

### Epic C — Cortex memory-native layer
Purpose: make memory operational inside the IDE.

Child slices:
- recall panel
- provenance surfaces
- memory health indicators
- run replay context
- org learning hooks

### Epic D — Mobile remote control (Remodex/Phodex-derived lane)
Purpose: ship day-one mobile control without pretending a phone is a full IDE.

Child slices:
- audit Remodex architecture / license / reuse path
- pairing and trust model
- provider-agnostic mobile bridge
- notification + approval inbox
- steer / pause / resume actions
- mobile Cortex recall

### Epic E — Org code and templates
Purpose: implement Karpathy’s “org code” idea in a bounded way.

Child slices:
- squad templates
- policy packs
- assignment rules
- review chains
- reusable layouts

### Epic F — Optional topology / spatial UX
Purpose: explore spatial views only after the product is already useful.

Child slices:
- pragmatic topology map
- evaluate Hoberman-sphere interaction
- keep or reject based on usability

## Prioritization

### P0
- Epic A
- Epic B
- Epic D (mobile foundation)

### P1
- Epic C
- Epic E

### P2
- Epic F

## Principle

If the Hoberman sphere helps, keep it.
If simple boards, lists, filters, and inspectors are better, choose the simple thing.

The product requirement is **legibility and control**, not a specific geometric gimmick.
