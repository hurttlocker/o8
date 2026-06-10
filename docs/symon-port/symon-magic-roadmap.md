# Symon magic roadmap — the next layer after presence

*2026-06-10. Executive strategy brief following the presence-layer ship
(0.1.313–318: Points, screen context, drop staging, glints, worker pulse,
chat continuity). Brainstormer deep-dive synthesized with the build-side
plumbing audit. Companion to `clicky-competitive-dossier.md` (built) and
`symon-presence.md` (architecture).*

## The one principle (the anti-cheese grammar)

> **The spoken verb applies to the present context — selection, screen, or
> fleet — and anything that changes the world passes a confirm card.**
> Selection → transform. Screen → point. Fleet → approve.
> One grammar, three nouns, one governance gate.

The 2024–26 cheese pattern is a pile of AI capabilities behind menus: a ✨
toolbar on selection, "Smart Reply" chips, a spoken changelog. Menus pretending
to be intelligence. Symon's magic is the **absence of the menu** — the noun is
whatever you're touching, the verb is whatever you say, and governance (not a
preset list) is what keeps it safe.

## Build next, in order

### 1. Selection-as-object transform — the Worker wedge (days) — **BUILT 0.1.319**

Hold Option with text selected anywhere on the Mac → the spoken sentence is
the verb, the selection is the noun → the text rewrites **in place**, with a
one-tap **Revert** chip in the dock. No selection → the verb applies to the
frontmost window: "reply to her that Thursday works but push to 2pm" reads the
open Mail thread (AX context), drafts in the user's register, stages a draft —
**never sends without the confirm card**.

- Magic moment: a clumsy paragraph rewrites itself where it sits. No copy,
  no chat window, no toolbar.
- Plumbing already shipped: `paste::grab_selection()` (AXSelectedText +
  Cmd+C fallback), `paste::paste_text()` (replaces selection at caret),
  `gather_window_context()` (frontmost app + AX excerpt), Mail
  search/read/draft/send-draft tools.
- New surface: the Revert chip (dock vocabulary, same as staged-file chips) +
  a held pre-state buffer — Symon's own undo, never trust the app's.
- Follow-on variant (cheap): transform-and-route — "turn this into a reminder
  for tomorrow 9am" sends the selection into the native tool instead of a
  rewrite. The confirm card doubles as disambiguation.

### 2. "What needs me?" — voice approval triage, the moat spoken (days–week) — **BUILT 0.1.320**

*Shipped as `o8_needs_me` (pending approval cards + attention-state lanes,
ReadOnly) plus `o8_approve_item` / `o8_reject_item` (title-resolved against the
live queue, Reversible → always carded). The model is taught needs_me-first so
the spoken proposal + card always name the real pending item. E2E verified:
list, approve-through-card, and all-clear paths.*

One phrase surfaces ONLY the fleet items blocked on the operator's decision
("two merges waiting; one touches a DB migration"), then walks approve/deny by
voice — each resolution gated by the existing confirm card. Destructive-class
items require more than a spoken yes.

- Explicitly NOT a "what happened" brief. Decision-surfacing only — the
  changelog version is the commodity trap the product brief warns about.
- Plumbing: `o8_status`, the approvals API (`o8_approve`/`o8_reject` family),
  confirm cards, worker pulse. The work is the "needs me" filter + the voice
  walk loop.
- This is the o8 moat (operator approval surface) rendered as voice. Neither
  Clicky can build it — they have no approval surface to speak.

### 3. The Guide pointer — the un-lost button (days) — **BUILT 0.1.321**

*Shipped as the `[GUIDE:x,y:label]` tag: the marker flies in, then dwells with
a soft sonar ping until the user's cursor reaches it (2.5s grace, 90s cap,
generation-guarded). E2E verified: model chose GUIDE unprompted for an "I'm
lost" question, ring persisted past the old 20s cap, and released ~3s after
the cursor arrived at the target.*

"Where do I click to reply?" / "I don't know what I'm looking at" → one
intent-gated screenshot → Symon names the screen plainly and the orange ring
**lands and dwells, pulsing** on the single likely target until the user acts
(instead of the 8s auto-fade). One sentence of description, one point — never
narrate the whole screen.

- Same Points primitive, same one-shot capture trust model — no new privacy
  surface. A `dwell` flag on the overlay protocol + a softer pulse.
- This delivers ~80% of the "kid installs it for their parent" story at
  one-shot cost.

## Supporting fix that rides any of these ships

**Permissions health in Voice settings — BUILT 0.1.322.** *Shipped: the
Permissions card now covers all five grants (Microphone + Screen Recording
added — mic via AVCaptureDevice runtime lookup, screen via CGPreflight with
the stale-after-rebind caveat in the hint copy), each with live status and a
deep-link Open action. Verified live in the glass settings window.*

Today's Screen Recording TCC saga
(pane said ON, API said denied, fixed only by `tccutil reset`) would hit every
user silently. Add a permissions row to the Symon settings surface: Mic /
Accessibility / Screen Recording each with live grant status and a fix action
(deep-link + the reset recipe). Converts an unfixable-looking failure into a
self-serve toggle. Also: Symon should SAY it ("I can't see the screen — check
Screen Recording in settings") — the honesty guard already does this; the
settings row closes the loop.

## Deliberately deferred

- **"Stay with me" continuous guidance** (point → watch → verify → advance) —
  the real consumer-expansion bet and the best narrative, but it needs a
  designed trust model for REPEATED screen capture first: explicit entry
  phrase, a visible "watching" dock state, auto-exit on completion/timeout.
  Don't write a line of it before that trust design exists.
- **Caregiver setup mode** (kid pre-configures big targets / patient pacing
  for a parent) — the install vector for the Guide story; config, not magic.
- **Watch-me-then-repeat transforms** — power-user feature in novice clothing.
- **Voice dispatch with grounded read-back** — depends on the harness `ground`
  artifact (harness vision Phase 1). Voice-fires-a-worker without grounding is
  the cheesy/dangerous version; wait for the plan-read-back to be real.

## Killed

- **Standalone morning brief / spoken changelog** — commodity summarization;
  its only valuable part (decisions) lives inside "what needs me."
- **Preset transform toolbar** (Improve / Shorten / Professional buttons) —
  presets cap the ceiling; free-form voice is the whole point.

## The two-products tension (named, resolved)

Worker + Coordination serve the operator we already have; the Guide serves a
different user (novice/older). Leading with all three equally would make Symon
a Swiss-army demo. Resolution: lead with the Worker grammar (daily-use wedge),
follow with the moat-in-voice (Coordination), ship the CHEAP 80% of Guide
(one-shot pointer) third — and treat continuous guidance as its own later bet
with its own trust design. The grammar principle keeps all three feeling like
one product.
