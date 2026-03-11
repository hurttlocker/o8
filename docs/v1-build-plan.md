# v1 Build Plan — Cortex IDE

## Goal of v1

Build the first version of **Cortex IDE** as a real, usable **agent command center**.

v1 should prove that one operator can manage an agent organization better than they can with:
- tmux grids
- scattered terminals
- ad hoc dashboards
- separate mobile notification apps
- stateless coding agents

## Karpathy thread -> exact product requirements

We are treating Karpathy’s thread as a concrete product spec input, not just inspiration.

### 1. “We’re going to need a bigger IDE”
**Requirement:** v1 must be a **desktop-first control tower**, not just an editor plugin.

Implication:
- multi-panel, monitor-friendly layout
- command-center default view
- one place to supervise many active agents

### 2. “The basic unit of interest is not one file but one agent”
**Requirement:** the primary UI entity is the **agent / run / squad**, not the file tree.

Implication:
- fleet sidebar before file explorer
- agent state, task, branch, logs, outputs, and cost are first-class
- files still matter, but they are downstream of runs

### 3. “Proper agent command center IDE for teams of them”
**Requirement:** v1 must support **multi-agent orchestration** as a first-class workflow.

Implication:
- agents grouped into squads
- quick assignment / steering / pause / resume / kill
- review queues across many runs

### 4. “I want to see/hide toggle them”
**Requirement:** v1 needs strong visibility controls.

Implication:
- filters
- saved views
- hide / pin / focus modes
- selected-agent drilldown

### 5. “See if any are idle”
**Requirement:** live state visibility must be obvious.

Implication:
- idle / running / blocked / waiting / reviewing / failed states
- health / alert signals
- stale-run detection

### 6. “Pop open related tools (e.g. terminal)”
**Requirement:** related tools must open inline from the agent context.

Implication:
- terminal drawer
- diff drawer
- PR drawer
- artifacts drawer
- memory / provenance drawer

### 7. “Stats (usage), etc.”
**Requirement:** resource visibility is core, not a settings afterthought.

Implication:
- token / cost / context meters
- per-agent and per-squad usage
- run duration / review lag / throughput

### 8. “Org code”
**Requirement:** v1 must support reusable operating patterns.

Implication:
- squad templates
- policy packs
- assignment / review rules
- reusable workflows and layouts

### 9. “Human orgs are not legible … real-time stats”
**Requirement:** the system must be **legible at every zoom level**.

Implication:
- clear fleet overview
- drilldown to squad
- drilldown to run
- drilldown to diff / memory / log evidence

### 10. “Control orgs on mobile, with voice etc.”
**Requirement:** mobile must exist in v1.

Implication:
- not a full phone IDE
- yes to remote operation, alerts, approvals, and steering

## v1 product boundaries

### In scope
- desktop command center
- multi-agent fleet management
- runtime attach / spawn / steer / interrupt
- logs / terminals / diffs / artifacts / review queue
- Cortex-backed memory / recall / provenance surfaces
- mobile remote companion
- GitHub / Git / worktree awareness
- org templates / layouts at a basic level

### Out of scope
- full editor parity with VS Code
- public landing page polish
- broad OSS launch
- deep visual gimmickry as a blocker
- full public cloud multi-tenant product

## Hoberman sphere stance

The Hoberman sphere is **not a v1 requirement**.

It is only justified if it improves legibility and navigation.

### Rule
If a simpler visualization works better, use the simpler visualization.

### v1 default
Start with:
- fleet list
- squad boards
- timeline / review rail
- inspector panels
- optional topology view

### Hoberman sphere as stretch
A topology view can be explored later if it helps compress complexity into a useful operator interaction.
But it should not slow down the real product.

## Phodex / Remodex stance

Phodex / Remodex is the strongest current clue for **mobile architecture**, not the product itself.

### What we should take
- QR pairing
- local-first bridge model
- phone as remote control
- secure relay-capable architecture
- notifications and quick actions

### What we should not do
- build Cortex IDE as “Codex remote control plus extras”
- let a Codex-specific bridge define the whole product architecture

### v1 recommendation
Use Remodex as a **bootstrap lane** for mobile remote-control mechanics, then generalize the bridge into Cortex IDE’s own control service.

## v1 architecture decisions

### Desktop
Desktop web app first.
No VS Code fork in v1.

### Mobile
Real paired iOS remote in v1.
The phone should handle:
- alerts
- approvals
- steering
- run watch
- memory lookup
- basic diff and PR skim

### Memory
Cortex runs under the hood for:
- recall
- provenance
- handoff continuity
- memory health
- replay context

### Runtimes
Support existing runtimes via adapters.
Do not marry one runtime.

## v1 release shape

### v1.0
- desktop command center shell
- runtime adapters for real agent sessions
- live state, logs, inspector, review rail
- basic Cortex panel
- basic mobile notifications and approvals

### v1.1
- better GitHub / diff / PR review experience
- better Cortex replay and provenance views
- improved mobile quick actions
- saved layouts and squad views

### v1.2
- org templates / “org code”
- richer topology / optional spatial views
- workload and policy automation

## Non-negotiable success bar

When v1 is real, the operator should be able to say:

> I can run an agent company from this.

Not:

> this is a cool AI dashboard.
