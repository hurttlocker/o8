# o8 — Interaction Styleguide (review-gating)

*The third design doc, and the one with teeth. [`DESIGN.md`](./DESIGN.md) is the visual **language** (palette, type, motifs); [`hurttlocker.md`](./hurttlocker.md) is the operator-locked **look** (row geometry, font weights, icons). This is the **interaction half** they don't cover — how a surface behaves over time: feedback timing, sibling cohesion, button hierarchy.*

**These are review-gating rules, not suggestions.** The `reviewer` agent and any UI review check changes against this file. A change that adds a control, a loading state, or a group of sibling elements must satisfy the relevant rule below or call out why it's exempt. Each rule is phrased so it's checkable from a diff.

---

## 1 — Feedback timing tiers

Every action has a perceived latency. Match the feedback to the wait — under-feedback feels broken, over-feedback feels busy. Four tiers, by how long the result takes:

| Latency | Feedback | Don't |
|---|---|---|
| **0–100ms** | Nothing extra — the result IS the feedback (the row updates, the value flips). | Don't add a spinner to an instant action; it flickers and reads as slower than doing nothing. |
| **100ms–1s** | **Disable + visually settle the control** that was pressed (the `busy` state). The user sees their press landed; no spinner needed. | Don't leave the button live (double-submits) and don't pop a full-screen loader. |
| **1–3s** | A **local spinner / progress indicator** in or beside the control or surface. Scoped to the thing that's working. | Don't block the whole view; don't show a bare frozen control with no motion. |
| **3s+** | **Staged labels** — name what's happening and let it change ("Reading sources…" → "Composing…"), not an indefinite spinner. | Don't show a spinner with no words past ~3s; the user can't tell live from hung. |

**Checks:**
- A mutating control (submit, save, revoke, dispatch) must enter a **disabled/busy state on press** until the result lands — never stay live through the round-trip. (o8: `RamsButton busy`, the `busy`/`disabled` prop pattern.)
- A wait that can exceed ~3s must surface **named stages**, not an endless spinner. (o8 reference: the Engineering Brain's "Reading N sources…" → tokens; orchestrator turn cards.)
- A `< 100ms` local state change must NOT introduce a spinner/skeleton.
- Optimistic UI is allowed and encouraged for the 100ms–1s tier — update immediately, reconcile on response, roll back on error (and the rollback must be visible, not silent).

---

## 2 — Sibling cohesion

Elements in the same group are siblings: a row of dock items, a stack of cards, a set of tabs, a cluster of buttons. **Siblings share their geometry and treatment** — height, padding, radius, font weight, icon size, gap. One snowflake in a group reads as a bug, not emphasis.

**Checks:**
- Controls/cards rendered from a `.map()` or sitting in the same flex/grid row must derive size + spacing from **one shared source** (a constant, a token, a shared component) — not per-item literals that happen to match today and drift tomorrow.
- A new element added next to existing siblings inherits their height, radius, padding, and weight. If it must differ, that difference is the *intended emphasis* (e.g. one primary in a button row) — not an accident.
- Don't hand-roll a one-off variant of a component that already has a shared primitive (o8: `RamsButton`, the settings `shared.tsx` primitives, the canvas-glass `ui.ts` chrome tokens). Extend the primitive or use it.
- Equal things look equal: a list of N peer items uses N identical rows. Differences in a peer set must encode real differences in state (active, error, revoked), surfaced through the shared vocabulary (status dot, pill), not bespoke geometry.

---

## 3 — Button hierarchy

A view has **one primary action**. Everything else is secondary, ghost, or danger. Two competing primaries means the user has to think about which one matters — that's the bug.

**Roles (o8: `RamsButton variant`):**
- **primary** — the one action the view is *for* (Send, Dispatch, Pair, Save). One per view/section. Carries the accent.
- **ghost / secondary** — supporting actions (Cancel, Refresh, Back, secondary navigation). Quiet; no accent fill.
- **danger** — destructive + irreversible (Revoke, Delete, Discard). Distinct danger tone, and **gated behind an inline confirm strip** — never a bare one-tap on a destructive action, never an overflow `…` menu.

**Checks:**
- No two primary-styled buttons in the same view competing for "the" action. If you need two emphasized actions, one is primary, the other steps down to secondary.
- Destructive actions use the **danger** role **and** a confirm step (the inline "you sure? · Confirm / Cancel" strip — see the Paired-devices revoke). No dropdown/overflow menus for actions (repo rule).
- The primary action is reachable without scrolling on the surface it belongs to (it's the point of the view).
- Button label is a **verb** for what happens (Revoke, Dispatch, Re-pair) — not "OK"/"Yes"/"Submit" where a specific verb fits.

---

## 4 — How this is enforced (the gate)

1. **Spec-ingested** — this file is in `ROOT_SPEC_FILES` (`src/lib/cortex/spec-ingest.ts`), so the Engineering Brain retrieves it and any orchestrator/worker asking "how should this behave" gets these rules.
2. **Reviewer-checked** — the `reviewer` agent (`.claude/agents/reviewer.md`) checks UI diffs against §1–§3 and reports violations with `file:line`, same as CLAUDE.md rules.
3. **Author checklist** — before shipping a UI change, confirm:
   - [ ] Every mutating control has a press→busy→result state (§1).
   - [ ] No spinner under 100ms; named stages past 3s (§1).
   - [ ] Sibling elements share one geometry source; no accidental snowflake (§2).
   - [ ] Exactly one primary action; destructive is danger + confirm strip (§3).

**Chunk-size note** (for the Brain): keep each H2/H3 here chunk-sized — the composer reads ~1,500 chars per row. The tables above are intentionally short so each rule is independently retrievable.
