# Symon teaching mode — draw-and-teach on screen, hands-free

**Status:** planned (2026-06-17). Sibling epic to the draw-localization revamp
(`draw-localization-revamp.md`, #1250). Operator directive: spec + file both as their own epics
before implementation.

## The goal

Reproduce Clicky's headline demo: the agent draws and *teaches* directly on the screen, hands-free —
e.g. "teach me the Pythagorean theorem" → it draws a triangle, labels sides a/b/c, writes a²+b²=c²,
**narrating in sync with each stroke**. Then generalizes (walk me through X on screen).

## Why this is a SEPARATE epic from #1250

#1250 (enumerate-then-pick) is about **precise targeting of existing UI elements** — point at *that*
button. Teaching mode is about **generating original annotations on arbitrary screen space** — there is
no element to target; the agent draws a triangle on blank pixels and talks through it.

That makes teaching mode **more achievable and arguably more demo-worthy** than precise targeting: it
sidesteps the hard AX/DOM localization problem entirely. The overlay is already an SVG canvas; the brain
already knows the content; the voice loop is already hands-free. What's missing is a richer draw
vocabulary and a way to *sequence* drawing with speech.

The two demos map cleanly:
- **Pythagorean (YouTube)** → teaching mode (this epic). Generative draw + synced narration on blank space.
- **FL Studio beat-making** → #1250 + this epic. Needs precise pointing at real app controls (#1250) AND
  the narrate-while-doing timeline (this epic).

## What we already have (the skeleton)

- Hands-free voice loop (trigger → STT → agent loop → TTS) — the hard part to bootstrap.
- A transparent, click-through overlay window over the captured monitor (`point_overlay.rs` +
  `/point-overlay` route) that renders **arbitrary SVG**.
- Seed draw primitives: `Shape::Point | Rect | Arrow` (`point_overlay.rs`), rendered by `DrawShape` in
  `point-overlay/page.tsx` with draw-on animation.
- Chunked, cancellable TTS (`tts/playback.rs`) — speaks in segments, already stoppable.
- The interrupt/cancel flag (0.1.374) — a long teaching sequence MUST be abortable; this reuses it.
- The two-tier brain (Gemini front / Claude background) — knows the content.

## Architecture

### 1. Generative draw vocabulary (extend the overlay)

Add primitives beyond box/arrow so the agent can draw a diagram, not just mark an element:

- `Shape::Line { x1,y1,x2,y2 }`, `Shape::Polyline { points[] }` — triangle edges, axes, connectors.
- `Shape::Text { x,y, text, size? }` — labels ("a", "b", "c"), equations ("a² + b² = c²"). Rendered as
  SVG `<text>` with the same glow/stroke treatment as the shapes.
- `Shape::Circle/Ellipse { cx,cy,r }` — emphasis rings, "this region."
- (later) `Shape::Path { d }` — freeform strokes for richer illustration.

All render in the existing `/point-overlay` SVG layer (`DrawShape`), reusing the screenshot→monitor
transform in `show_points`. Coordinates here are model-chosen positions on blank space (no AX/DOM needed),
so the existing pixel→monitor map is sufficient — **no dependency on #1250.**

### 2. Narrate-while-drawing timeline (the core new mechanism)

Today: the model emits all tags at once, they animate together, then TTS speaks the whole reply once.
Teaching needs **interleaving**: draw a stroke → say a line → draw the next → say the next.

- New script protocol: the model emits an **ordered list of steps**, each `{ draw?: <primitive>,
  say?: <line>, pauseMs? }`. Proposed inline form `[TEACH]` block or a JSON script the loop parses
  (cleaner than many inline tags).
- A **timeline executor** (Rust side, in `point_overlay` or a new `teach.rs`): for each step, push the
  draw primitive to the overlay (incrementally — additive, not replace), then speak `say` and **await
  that TTS segment** before advancing (reuse `tts::playback` with a per-segment completion signal),
  honoring `pauseMs`.
- Additive overlay: the overlay must ACCUMULATE primitives across steps (the triangle stays as labels
  get added), not clear between steps. Add an `append`/`step` mode to the `o8:point-show` payload.
- Interruptible: each step checks the 0.1.374 cancel flag; Escape / tap-to-stop ends the lesson cleanly
  (clears the overlay, stops TTS).

### 3. Teaching-script prompt mode (brain)

When the ask is "teach / explain / walk me through … on screen," the brain produces a **teaching script**
(the step list) instead of a one-shot answer + tags. A new `screen_prompt_section` variant teaches the
`[TEACH]` script format and the available primitives. Gemini/Claude already hold the content; this is a
prompt + output-shape change, not new knowledge.

## Phases (each with a verify gate)

- **P1 — generative primitives.** `Shape::Line/Polyline/Text/Circle` + parser + `DrawShape` render.
  *Verify:* a hand-authored script draws a labeled triangle + "a²+b²=c²" on screen, correctly placed.
- **P2 — timeline executor.** Additive overlay + step sequencing + per-segment TTS await + cancel checks.
  *Verify:* the triangle draws stroke-by-stroke with narration synced to each stroke; Escape aborts mid-lesson.
- **P3 — teaching-script prompt mode.** `[TEACH]` protocol + prompt; route "teach/explain … on screen" to it.
  *Verify:* "teach me the Pythagorean theorem on my screen" → full synced lesson, hands-free, end to end.
- **P4 — polish.** Erase/clear/redraw, pacing controls, `prefers-reduced-motion` gate, label legibility,
  multi-board lessons. *Verify:* a 5+ step lesson reads smoothly and stays legible.

## Files

- `src-tauri/src/point_overlay.rs` — new `Shape` variants + parser/tests; additive/step payload mode;
  (possibly) a `teach.rs` timeline executor.
- `src/app/point-overlay/page.tsx` — render line/polyline/text/circle; step/append mode; draw-on per step.
- `src-tauri/src/agent/mod.rs` + `screen.rs` — `[TEACH]` script protocol, prompt section, route
  teach/explain asks; reuse the cancel flag for abort.
- `src-tauri/src/tts/playback.rs` — per-segment completion hook so the executor can await each spoken line.

## Decisions / risks

- **Script format:** a JSON `[TEACH]{...}` block beats many inline `[DRAW]` tags for an ordered lesson —
  one parse, explicit ordering, easy to validate. Keep inline `[DRAW]`/`[POINT]` for one-shot marks.
- **Sync fidelity:** the win is *await the spoken segment before the next stroke*. Needs a TTS
  per-segment done signal (today playback is fire-and-forget). Small addition to `playback.rs`.
- **Interrupt:** lessons are long → must reuse the 0.1.374 cancel path (Escape / tap-to-stop). Already built.
- **Placement on blank space:** model picks coordinates; no AX/DOM needed → independent of #1250. For
  lessons drawn *over* a real app (annotate this chart), precise anchoring would later borrow #1250.
- **Content accuracy:** the brain's job; out of scope for the drawing infra.
- **Relationship to #1250:** independent to build; they compose for the FL-Studio-style "point at the real
  control AND narrate the step" case.
