# Issue Map — Cortex IDE v1

Repo: `hurttlocker/cortex-ide`

## How the issue system is structured

We are using:
- **epics** for major product lanes
- **issues** for bounded implementation slices

The issue tree is intentionally organized around the real product wedge:
- command center first
- runtime / workflow surfaces second
- mobile in v1
- Cortex under the hood where it creates real leverage
- topology / Hoberman as optional, not sacred

---

## Epic A — Command center core
- **#1** — [Epic] v1 command center core

Child issues:
- **#7** — Bootstrap desktop shell (white placeholder shell + command-center layout)
- **#8** — Define fleet state model and agent/squad status taxonomy
- **#9** — Build agent inspector with inline tool drawers (terminal, diff, artifacts, memory)
- **#10** — Build timeline / event rail and saved focus views

Why it exists:
- this is the Karpathy baseline
- the unit is the **agent**, not the file
- the UI must already feel like a command center before it feels like an editor

---

## Epic B — Runtime adapters + software workflow surfaces
- **#2** — [Epic] runtime adapters + software workflow surfaces

Child issues:
- **#11** — Define runtime adapter contract for Cortex IDE
- **#12** — Implement OpenClaw / ACP adapter MVP
- **#13** — Ship Git / GitHub / worktree review surface

Why it exists:
- the product is fake if it cannot supervise real work
- runtime abstraction is part of the moat
- review, worktree, and GitHub surfaces are part of the operator loop

---

## Epic C — Cortex memory-native operator layer
- **#3** — [Epic] Cortex memory-native operator layer

Child issues:
- **#14** — Build Cortex recall + provenance panel
- **#15** — Add memory health indicators and run replay context

Why it exists:
- Cortex is not just a backend detail
- memory, provenance, and replay context are part of the product advantage

---

## Epic D — Mobile remote control via Remodex/Phodex-derived lane
- **#4** — [Epic] mobile remote control via Remodex/Phodex-derived lane

Child issues:
- **#16** — Audit Remodex repo, license, architecture, and adoption mode
- **#17** — Generalize mobile bridge contract beyond Codex
- **#18** — Build mobile inbox for alerts, approvals, steering, and run watch

Why it exists:
- Karpathy explicitly called out mobile control
- Remodex is the strongest current open-source architecture clue
- but the bridge must become **Cortex IDE’s** control layer, not stay Codex-specific

---

## Epic E — Org code templates, policy packs, and reusable operating patterns
- **#5** — [Epic] org code templates, policy packs, and reusable operating patterns

Child issues:
- **#19** — Add squad templates and saved operating layouts
- **#20** — Add policy packs for assignment, review chains, and approval rules

Why it exists:
- this is the bounded product form of Karpathy’s “org code” idea
- agent orgs should become reusable, not reassembled from scratch every time

---

## Epic F — Optional topology and Hoberman evaluation
- **#6** — [Epic] optional topology and Hoberman evaluation

Child issues:
- **#21** — Run pragmatic topology spike and Hoberman keep-or-kill evaluation

Why it exists:
- topology is optional
- Hoberman is a hypothesis, not a religion
- if simpler views are better, simpler views win

---

## Priority summary

### P0
- **#1** Command center core
- **#2** Runtime adapters + workflow surfaces
- **#4** Mobile remote control via Remodex/Phodex-derived lane
- plus child issues **#7–#13**, **#16–#18**

### P1
- **#3** Cortex memory-native layer
- **#5** Org code templates / policy packs
- plus child issues **#14–#15**, **#19–#20**

### P2
- **#6** Optional topology / Hoberman evaluation
- child issue **#21**

---

## Recommended execution order

### Sequence 1 — Make the shell real
- #7
- #8
- #9
- #10

### Sequence 2 — Make it operate real runs
- #11
- #12
- #13

### Sequence 3 — Make mobile real early
- #16
- #17
- #18

### Sequence 4 — Turn memory into a visible moat
- #14
- #15

### Sequence 5 — Add org-code leverage
- #19
- #20

### Sequence 6 — Evaluate topology only after the system is already useful
- #21

---

## Principle

The product requirement is **legibility, control, and reusable agent operations**.

Not:
- a particular geometry
- a pretty graph
- a VS Code fork for its own sake
