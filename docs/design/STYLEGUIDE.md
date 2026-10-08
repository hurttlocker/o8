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

## 4 — Screen structure and layout

These rules apply across setup, Settings, connection flows, project views, and the workspace. Typography, button treatment, and dense navigation rows still follow [`hurttlocker.md`](./hurttlocker.md). A dense sidebar is not a template for a full-window task.

| Surface | Layout contract |
|---|---|
| Setup, connection, or focused task | One stable content frame, up to 800 px wide with 20–32 px responsive insets. Header, context, choices, and action share its edges. Keep the frame width stable when advancing or showing an error. |
| Settings or detail page | Group related controls under one heading and short description. Use a readable main column; add a second column only for independent supporting information. |
| Workspace | Give the work surface the available space. Navigation, current project, agent status, and next action remain easy to locate as panels open or resize. |
| Dense navigation | Keep the existing compact row geometry. Show enough identity and status to choose an item without expanding it. |

### Reading order and grouping

- Every screen answers, in order: where am I, what is the current state, what do I need to choose, and what happens next. Keep the title and explanation together, choices together, and action beside the choice it acts on.
- Use 8 px within a row, 16 px between related controls, and 24–32 px between sections. Derive sibling spacing from the same component or style object. Avoid applying the dense sidebar's spacing to page content.
- A border or card groups a real decision or state. Avoid cards inside cards for unrelated decoration. A simple list can live directly in the frame.
- Put readiness beside the tool or connection it describes. Distinguish checking, ready, unavailable, and failed; a discovered installation does not prove a successful operation.

### Progressive disclosure and recovery

- Start a common task with the smallest sufficient set of choices. Put model routing, worker configuration, and other expert controls behind a labeled expansion such as Customize. Preserve saved choices when that section is closed.
- Show persistent progress for a multi-step task. Compute it from observed state; do not mark an unchecked connection or unopened workspace complete. Keep selected project identity visible through retries and later steps.
- Independent discovery must render independently. A slow tool scan must not hide available projects or prevent a manual folder choice. Name a long wait and keep an available next action reachable.
- Keep error and recovery feedback in the section that failed. Retain context and choices. Optional permissions and privacy choices remain explicit.

### Actions and optional setup

- Use anchors for navigation and buttons for local actions. A local action that opens configuration must have a visible control boundary, a verb label, and `aria-expanded` / `aria-controls`; do not rely on accent text to advertise interactivity. Reuse the surface’s existing secondary button primitive.
- Put related optional actions in one group. Open one setup subtask at a time inside the stable frame; give it a name and an explicit return action. Closing or switching panels must preserve selected values and return keyboard focus to the initiating control. Opening a panel performs no installation, authentication, or settings write.
- A tool setup panel groups identity, observed readiness, remediation, and its action. Show the exact install command before copying; name the provider in accessible action labels. A failed copy or refresh keeps instructions and selections available. Refresh remains contextual to discovery, separate from saving setup.
- An installed tool needing sign-in gets a named recovery destination with its exact supported command and a separate readiness check. Opening it does not run the command. An embedded terminal requires an explicit Run action, owns a temporary shell, and terminates that shell on close or connection loss. Keep a manual copy path available when the terminal cannot connect.
- Name the continuation destination in the primary action and describe the next required step beside it. Persist whether setup was entered to open a project or to change tool settings, so restarting cannot change that intent. If a completed action disappears, restore focus to the nearest stable return control.
- Provider marks identify choices in setup and connection flows. Reuse existing assets in a fixed identity slot, with optical sizing for the mark, a readable tool name, and a separate status. Hide redundant brand graphics from assistive technology. Dense workspace history keeps its existing text-first rule.
- A bundled agent uses the same identity slot and readiness row as installed tools. When no licensed mark is available, use its text symbol in the existing typography and theme tokens. Show plan and platform details beside the choice; installation scans belong only to external tools. Availability follows the runtime registry, never a display-only promise.
- Use the existing page and grouped-surface tokens for hierarchy. A new border, background, or column must organize a real choice or supporting information; adding a panel does not require adding a new palette, font, or Settings control variant.
- Full-window native setup follows the selected glass material. Hide and make background workspace content inert while it is visible, then restore its prior state on close. Keep primary-action ink separate from the transparent surface and use the shared frost for scrolling action docks. Browser and solid surfaces keep the opaque fallback; operator appearance preferences are preserved.

### Window fit

- Verify the live surface at a compact 900 × 700 window and a wide 1680 × 1050 window, in light and dark themes. Content may scroll vertically, but must not clip horizontally or require a whole-screen horizontal scroll.
- A long list or advanced section gets its own bounded region when needed. Keep the task title and primary action reachable without hunting through unrelated content. A short viewport must have a clear vertical scrolling path.

### Optional setup and sensory feedback

- Voice, device installation, and other optional setup belong in named destinations with a clear return action. Keep the selected project and required setup progress intact. Platform-limited access remains visible with a short reason; unknown permission state never counts as granted.
- Group permissions by the feature they enable. Start voice setup with microphone access and a local input check. Put broader desktop access behind a named disclosure. A successful input check does not establish transcription, provider health, or a successful voice conversation.
- Reuse the voice identity from the live app: its shared orb, waveform geometry, and polishing silhouette. The owned voice palette remains a brand exception; surrounding chrome uses theme tokens. Feature previews stay static and labeled. Only measured microphone input drives the test waveform; never imply recording, transcription, or polishing from a decorative animation.
- An install QR encodes the same public URL as its readable link. Keep installation separate from pairing and credential enrollment. Show the destination, copy failure recovery, and an optional way back.
- Animate a meaningful step or disclosure change for pointer interaction only. Use opacity and at most 4 px translation, 180 ms, and `cubic-bezier(0.22, 1, 0.36, 1)`. Keep the frame stable and controls interactive. Cancel interrupted transitions; keyboard actions and reduced-motion preference take effect immediately. Do not animate scans, polling, or scrolling.
- Optional UI sounds start silent and use an explicit, persistent toggle. Use short, low-volume original cues for presses and navigation, and reserve completion cues for confirmed outcomes. Do not play on page load or polling. Keep microphone tests silent so feedback cannot be mistaken for input. Sound and reduced motion are independent preferences.
- Rapid presses must not stack cues or raise their volume. A new cue releases the previous one, and muting releases an active cue immediately with a short fade. Interactive terminals remain silent; their keystrokes are task input.
- Preserve the existing fonts and Settings buttons. Sensory feedback does not add tap scaling, hover movement, decorative loading, or a new button system.

## 5 — How this is enforced (the gate)

1. **Spec-ingested** — this file is in `ROOT_SPEC_FILES` (`src/lib/cortex/spec-ingest.ts`), so the Engineering Brain retrieves it and any orchestrator/worker asking "how should this behave" gets these rules.
2. **Reviewer-checked** — the `reviewer` agent (`.claude/agents/reviewer.md`) checks UI diffs against §1–§4 and reports violations with `file:line`, same as CLAUDE.md rules.
3. **Author checklist** — before shipping a UI change, confirm:
   - [ ] Every mutating control has a press→busy→result state (§1).
   - [ ] No spinner under 100ms; named stages past 3s (§1).
   - [ ] Sibling elements share one geometry source; no accidental snowflake (§2).
   - [ ] Exactly one primary action; destructive is danger + confirm strip (§3).
   - [ ] Screen structure, action semantics, panel return/focus, grouping, and compact/wide window fit satisfy §4.

**Chunk-size note** (for the Brain): keep each H2/H3 here chunk-sized — the composer reads ~1,500 chars per row. The tables above are intentionally short so each rule is independently retrievable.
