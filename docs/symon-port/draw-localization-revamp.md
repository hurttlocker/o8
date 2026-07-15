# Symon draw-localization revamp — Clicky-quality "draw on screen"

**Status:** Phase 0 + Phase 1 + Phase 2 implemented (2026-07-15); Phase 3 remains planned. Automated
verification covers role policy, catalog mapping/prompt injection, exact-tag parsing/round trips, the
full Rust library suite, browser-agent route, and the Symon tool bridge. Native Mail/Settings plus o8
Browser dogfood remain the visual gates because the running `/Applications/o8.app` wasn't replaced mid-run.

## The problem

Symon's "point at / box / draw on the screen" feature localizes by **vision guess**: `screen::capture`
sends a downscaled screenshot to Gemini, Gemini emits `[POINT:x,y]` / `[DRAW:rect:x1,y1,x2,y2]` in
screenshot pixels, and `point_overlay::show_points` maps those pixels to the monitor and draws.

0.1.374 added an AX hit-test that snaps the guessed pixel to the element under it
(`paste::ax_frame_at_screen_point` → `point_overlay::ax_snap_frame`). That tightens a roughly-right
guess but has two structural failures (both seen live on x.com-in-Chrome):

1. **Wrong guess → wrong place.** Gemini guessed the X "Post" button was in the bottom-left (over the
   o8 terminal). Snapping can't rescue a guess that points at the wrong window. *Root cause: vision
   guessing is the localization method.*
2. **Over-snap to a container.** "Box Edit Profile" boxed the whole Twitter window, because Chrome web
   content barely exposes an AX tree, so the hit-test returned the big `AXWebArea`/window group and the
   55%-area gate was too loose. *Root cause: snapping to a container role + a web surface with no
   per-element AX.*

When this plan was written Gemini was the only vision front brain. The current Control+Fn default is
Claude Sonnet 5 and it receives the screenshot directly, but the diagnosis is unchanged: this is a
localization-method problem, independent of which vision-capable model chooses the target.

## The target (what Clicky does)

Clicky doesn't guess pixels. It reads the **accessibility tree** to get the real elements — "a button
labeled 'Post' at exactly (x, y, w, h)" — and draws on that. Vision is only its fallback for raw
pixels (video, canvas). For web it leans on the browser's DOM, not the macOS AX tree.

So the revamp replaces *guess-then-snap* with **enumerate-then-pick**, across three localization tiers,
vision demoted to last resort:

| Tier | Surface | Localization | Precision |
|---|---|---|---|
| 1 | Native macOS app (Mail, Settings, Finder, Calendar, o8 itself) | AX-tree enumeration → labeled element catalog with exact frames → model picks by label | exact (frame is ground truth) |
| 2 | Web **inside o8's embedded browser** (canvas card / Browser tab) | page-agent DOM: matched element's `getBoundingClientRect` → screen-mapped via the iframe's screen rect + canvas zoom | exact |
| 3 | Fallback: raw pixels (video/canvas), sparse-AX, or external apps we can't enumerate | current vision guess, but role-filtered so it never snaps to a container | best-effort, never worse than today |

**External Chrome web pages are explicitly out of scope** — no DOM access, no AX. The product answer is
"do web tasks in o8's browser," where Tier 2 applies.

## End-to-end dogfood gate

The native path now emits three correlated, privacy-safe events: capture reports only AX/capture counts
and timing, model reports only exact-versus-pixel tag counts, and overlay reports only resolver outcomes.
No labels, screen text, prompts, images, or model responses enter these events. Start the gate before the
gesture so old log entries cannot produce a false pass:

```bash
npm run dogfood:symon-localization -- --expect exact
```

Focus a native surface such as Notes or System Settings, hold **Right Option**, say “Point at the Search
field,” and release. Right Option is the screen-aware Symon agent; Fn is ordinary dictation and
Control+Fn is smart compose. The command passes only when one trace proves AX catalog capture, an exact
`[el:id]` model choice, and resolution through the production overlay code with no stale id.

Use `--expect fallback` on an external browser, video, or canvas to prove the pixel route still renders
without snapping to a container. Then visually confirm the mark is tight rather than a window-sized box.
Use `--expect web` with a local page visible in o8's Browser panel or canvas to prove DOM catalog capture,
an exact `[web:id]` model choice, a live selector refresh, and production overlay resolution as one trace.
For `GUIDE`, move the cursor to the rendered target and confirm the dwell/release behavior; repeat the
exact test on a second display to cover monitor mapping. These two visual assertions remain manual because
the structured gate deliberately records geometry counts rather than private screen contents.

## Architecture

### The catalog + the tag-protocol change

Today the model emits coordinates. After the revamp it is handed a **catalog** and references entries:

- Native: catalog = `[{ id, role, label, frame_global_pts }]` built from the AX walk. Injected into the
  prompt as a compact list (`[el:12] Button "Post" rect=…`, `[el:13] Link "Home" rect=…`). The screenshot still rides
  along for disambiguation, but the model emits `[DRAW:el:12]` / `[POINT:el:12]`, not pixels.
- Web: catalog = the `interactive: [{ selector, tag, label }]` array `o8_browser_read` **already
  returns**. Model emits `[DRAW:web:<selector>]` / `[POINT:web:<selector>]`.
- Fallback: the existing `[DRAW:rect:px…]` / `[POINT:x,y]` pixel forms stay valid for when no catalog
  entry matches (Tier 3).

`point_overlay::ParsedTag` now carries an optional native `element_id`; Phase 2 adds a web target.
`show_points` resolves a catalog id directly to its frame (no hit-test) and a web selector via
a new page-agent rect call. The pixel path is unchanged.

### Tier 1 — native AX enumeration

The implementation isolates a bounded depth-first AX walk in `screen_localization.rs`, following the
same `AXFocusedWindow → AXChildren` approach used by paste context. For actionable roles it records
`{ id, role, label, frame }`:

- **Actionable roles:** `AXButton`, `AXLink`, `AXTextField`, `AXTextArea`, `AXMenuItem`,
  `AXMenuButton`, `AXPopUpButton`, `AXCheckBox`, `AXRadioButton`, `AXTab`, `AXStaticText` (label
  anchors), `AXImage` (with description). Container roles (`AXWindow`, `AXGroup`, `AXScrollArea`,
  `AXWebArea`, `AXToolbar`, `AXList`) are descended but **never** emitted as draw targets.
- **Label priority:** `AXTitle` → `AXDescription` → `AXValue` → `AXHelp`.
- **Frame:** `AXPosition` + `AXSize` via `AXValueGetValue` — the FFI added in 0.1.374
  (`paste.rs`). Frames are global logical points (top-left), the same space `point_overlay` already maps
  into.
- Cap ~80 elements, depth ~8, on the same `run_on_main_thread` pass; skip zero-size / offscreen.

### Tier 2 — embedded-browser DOM

Canvas browser cards use the same-origin/proxied iframe agent; the Browser panel normally uses o8's
host-owned native child webview, whose injected agent can inspect any origin without giving the page
Tauri capability. Both now return the same bounded geometry envelope.

- Page-agent verb **`rect(selector)`** returns current element geometry and is exposed as
  `o8_browser_rect`; `localize` returns the bounded catalog Symon captures before the model turn.
- Iframe targets are transformed into the main-webview viewport, including canvas/card transforms and
  clipping. Native targets stay in page-viewport coordinates until Rust anchors them to the child window.
- Rust maps both envelopes into global logical points, rejects hidden or unfocused surfaces, and refreshes
  the chosen selector after the model turn so a layout shift cannot silently reuse stale geometry.

### Tier 3 — vision fallback (hardened)

Keep the guess-then-snap path for when no catalog matches, but **role-filter the snap**: only snap to a
leaf actionable role; if the hit is a container (`AXWebArea`/`AXGroup`/`AXScrollArea`/`AXWindow`) fall
straight back to the raw vision pixel. This alone kills the "boxed the whole window" case.

## Phases (each with a verify gate)

- **Phase 0 — stopgap (implemented 2026-07-14).** Role-filter the shipped AX-snap (Tier-3 fix). *Verify:*
  "box the Edit Profile button" on x.com no longer boxes the window (falls back to the point); native
  apps unaffected. ~30 lines in `point_overlay.rs` + a role read.
- **Phase 1 — native catalog (implemented 2026-07-14).** `enumerate_actionable`, catalog → prompt injection,
  `[el:id]` tag + resolver. *Verify:* in Mail/Settings, "box the Send button" / "point at Search" lands
  on the exact control, repeatably, with no screenshot-pixel guess in the path.
- **Phase 2 — web DOM (implemented; native dogfood pending).** Browser-agent geometry + iframe/native
  viewport→screen map + numeric `[web:id]` tags with a live selector refresh. *Verify:* open
  x.com **in o8's browser**, "box the Post button" snaps tight to the button.
- **Phase 3 — protocol + UX polish.** Unify the tag protocol + fallback ordering; add Clicky's
  continuous-narrate-while-drawing and labeled pointer-arrow vocabulary. *Verify:* the Farza
  Pythagorean-style walkthrough (point → explain → next) reads smoothly.

## Files

- `src-tauri/src/screen_localization.rs` — bounded AX walk, role policy, frame/label catalog, compact
  prompt serialization, and the role-filtered point hit-test. This owns localization instead of
  adding more unrelated behavior to the already-large paste module.
- `src-tauri/src/paste.rs` — retains the edit/window-context AX paths; the old unfiltered pointer
  hit-test moved into the localization domain.
- `src-tauri/src/point_overlay.rs` — `TagKind::Element`/`Web`, catalog resolver, role-filtered Tier-3
  snap, parse tests.
- `src-tauri/src/agent/mod.rs` / `screen.rs` — build the catalog when a draw/point is likely; inject the
  compact element list into the prompt; teach the `[el:id]`/`[web:selector]` protocol in
  `screen_prompt_section`.
- `src/lib/browser-agent/page-agent.ts` — `rect()` verb returning element geometry.
- `src/lib/mcp/o8-webview-tools.ts` + `src/app/api/browser/agent/route.ts` — `o8_browser_rect` wiring.

## Decisions / risks

- **Prompt size:** an 80-element catalog is compact (`[id] role "label"` ≈ 25 chars each ≈ 2 KB). Cap +
  truncate by on-screen prominence (larger/visible first).
- **Ambiguous labels** (two "Edit" buttons): the screenshot stays attached so the model disambiguates by
  position; ids make the choice explicit.
- **AX permission** already required for dictation/paste; missing → Tier-3 vision fallback (graceful).
- **External Chrome** stays Tier-3 (vision). Don't chase DOM access into third-party browsers — route web
  work through o8's browser instead.
- **TTS (separate track):** default Symon voice = the same free "press play" voice o8 uses on agent
  messages; "voice quality" later = speech-to-speech (OpenAI/Google realtime). Not part of this epic.
