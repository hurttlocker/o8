# Symon draw-localization revamp — Clicky-quality "draw on screen"

**Status:** planned (2026-06-17). Operator chose "write the revamp plan" after live testing showed the
vision-guess box landing on the wrong window / over-covering web content.

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

**Claude is not in this path.** Gemini alone is the eyes; Claude is only the async background brain.
So this is purely a localization-method problem, not a "mixing models" problem.

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

## Architecture

### The catalog + the tag-protocol change

Today the model emits coordinates. After the revamp it is handed a **catalog** and references entries:

- Native: catalog = `[{ id, role, label, frame_global_pts }]` built from the AX walk. Injected into the
  prompt as a compact list (`[12] button "Post"`, `[13] link "Home"`, …). The screenshot still rides
  along for disambiguation, but the model emits `[DRAW:el:12]` / `[POINT:el:12]`, not pixels.
- Web: catalog = the `interactive: [{ selector, tag, label }]` array `o8_browser_read` **already
  returns**. Model emits `[DRAW:web:<selector>]` / `[POINT:web:<selector>]`.
- Fallback: the existing `[DRAW:rect:px…]` / `[POINT:x,y]` pixel forms stay valid for when no catalog
  entry matches (Tier 3).

`point_overlay::parse_point_tags` gains `TagKind::Element { id }` and `TagKind::Web { selector }`
variants; `show_points` resolves a catalog id directly to its frame (no hit-test) and a web selector via
a new page-agent rect call. The pixel path is unchanged.

### Tier 1 — native AX enumeration

Reuse the depth-first walk in `paste::gather_window_context` (`paste.rs:592–723`), which already
descends `AXFocusedWindow → AXChildren` reading `AXRole`/`AXValue`. New variant
`paste::enumerate_actionable(window) -> Vec<AxElement>` that, for actionable roles, records
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

The canvas browser cards (`browser-card.tsx`, `<iframe data-o8-browser="canvas">`) and the Browser tab
(`O8BrowserPane.tsx`, `data-o8-browser="panel"`) are same-origin/proxied iframes with reachable DOM.
`page-agent.ts` `read()` already computes `getBoundingClientRect` to filter visibility but discards it.

- Add page-agent verb **`rect(selector)`** (or `read({ includeRects:true })`) returning iframe-local
  `{ left, top, width, height }`. Expose as `o8_browser_rect` for parity.
- Screen-map in the overlay: `iframeScreenRect = querySelector('iframe[data-o8-browser]').getBoundingClientRect()`
  (+ canvas `zoom`/`pan` for canvas cards) → `screen = iframeScreenRect.origin + elementRect.origin`.
  The element picker (`browser-card.tsx:242–291`) already does the rect+scroll math — reuse it.

### Tier 3 — vision fallback (hardened)

Keep the guess-then-snap path for when no catalog matches, but **role-filter the snap**: only snap to a
leaf actionable role; if the hit is a container (`AXWebArea`/`AXGroup`/`AXScrollArea`/`AXWindow`) fall
straight back to the raw vision pixel. This alone kills the "boxed the whole window" case.

## Phases (each with a verify gate)

- **Phase 0 — stopgap (cheap, ship first).** Role-filter the shipped AX-snap (Tier-3 fix). *Verify:*
  "box the Edit Profile button" on x.com no longer boxes the window (falls back to the point); native
  apps unaffected. ~30 lines in `point_overlay.rs` + a role read.
- **Phase 1 — native catalog (the big win).** `enumerate_actionable`, catalog → prompt injection,
  `[el:id]` tag + resolver. *Verify:* in Mail/Settings, "box the Send button" / "point at Search" lands
  on the exact control, repeatably, with no screenshot-pixel guess in the path.
- **Phase 2 — web DOM.** `o8_browser_rect` + iframe→screen map + `[web:selector]` tag. *Verify:* open
  x.com **in o8's browser**, "box the Post button" snaps tight to the button.
- **Phase 3 — protocol + UX polish.** Unify the tag protocol + fallback ordering; add Clicky's
  continuous-narrate-while-drawing and labeled pointer-arrow vocabulary. *Verify:* the Farza
  Pythagorean-style walkthrough (point → explain → next) reads smoothly.

## Files

- `src-tauri/src/paste.rs` — `enumerate_actionable` (reuses the AX walk + the 0.1.374 AXPosition/AXSize
  reads); role lists.
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
