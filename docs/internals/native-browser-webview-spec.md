# Native browser webview architecture

**Goal:** replace o8's embedded Browser pane (currently an iframe + same-origin proxy, with a laggy headless-Chrome JPEG fallback) with a **native child `WebviewWindow` that o8 owns**, positioned over the right-panel rect. This is the ONE surface that is both **smooth** (native render, origin-sensitive auth apps like Clerk work) AND **grabbable/agent-drivable** (the native host evals into a webview it owns, which bypasses same-origin policy).

The cited seams describe the architecture; verify their current locations before changing the implementation.

---

## Why this, and why not the alternatives (don't re-litigate)

The embedded browser must let o8 **grab** an element (read its DOM: tag, computed styles, a11y, selector) and **drive** it (agent click/type/read by selector). That needs to read the page's DOM. Four shapes were tried:

1. **Same-origin reverse proxy** (o8 fetches localhost:3000 and re-serves it from o8's origin): grabbable, but **Clerk renders blank**. Clerk is *origin-locked* — its dev-browser handshake + Frontend API key off `window.location.origin`; re-serving from o8's origin breaks it (`dev-browser-missing`, redirect loops). Confirmed via Clerk docs: there is **no header/script fix**; the proxy can never render Clerk. (Clerk's `proxyUrl`/satellite/`allowedRedirectOrigins` all require the *dev app* to change its own config + same-domain — not unilateral, not general.)
2. **Direct cross-origin iframe**: Clerk renders in a normal browser, BUT (a) o8 can't read it (same-origin policy), and (b) **in macOS WebKit it ALSO blanks** because WebKit *partitions cross-origin iframe storage* — Clerk's dev-browser can't complete in a sub-frame. So iframe-direct is a dead end on o8's platform.
3. **Headless-Chrome engine + polled JPEG** (the `O8EnginePane` fallback): renders Clerk and remains agent-drivable through Playwright/CDP, but frame polling adds enough input latency that it should remain a deep fallback.
4. **Native host-owned webview** (THIS spec): a top-level native webview (not a sub-frame) navigated directly to `localhost:PORT`. Native render → smooth + Clerk works (real origin, first-party storage, no iframe partitioning). The native host (`webview.eval`) injects the in-page agent → grab/agent work **regardless of origin**, because same-origin policy binds *web frames*, NOT the native host. **Generalizes to every origin-sensitive app, no per-app config.**

The reframe: **it's not a same-origin problem, it's a "who owns the JS context" problem.** When Rust calls `eval` on a webview o8 created, that JS runs in the page's main world with full DOM access at any origin.

**Do NOT** use Tauri *multiwebview* (multiple `Webview`s in one window, `unstable` feature) — it has shipping-blocker bugs (positioning #10420, resize #10131, last-child-only #11376, focus #12568). Use a child **`WebviewWindow`** (the STABLE API o8 already ships).

---

## The plumbing already exists (95% copy-paste)

Verify these, they're the templates:

- **Child `WebviewWindow` creation (frameless, transparent, vibrancy, rounded corners):**
  - `src-tauri/src/dock_window.rs:104` — `WebviewWindowBuilder::new(app, DOCK_LABEL, WebviewUrl::External(parsed)).decorations(false).transparent(true)...`
  - `src-tauri/src/lib.rs:3058` — the voice-settings window (same pattern + `apply_vibrancy` + `round_window_corners(&win, 22.0)` at `lib.rs:3092`).
- **JS→Rust hit-rect + native repositioning (THE positioning pattern):**
  - command `dock_set_hit_rect(x,y,w,h)` at `src-tauri/src/lib.rs:3020`, registered at `lib.rs:3725`.
  - storage `set_hit_rect` at `dock_window.rs:206`; `reposition(window)` at `dock_window.rs:339` (handles `scale_factor()` → LogicalPosition); resize via `window.set_size(LogicalSize…)` at `dock_window.rs:184`.
- **Eval into an arbitrary webview BY LABEL (the grab/agent bridge):**
  - `~/tauri-plugin-mcp/src/desktop.rs:133` — `get_webview_for_eval(app, label)` → `app.get_webview_window(label)`. **Create the child window with a known label (e.g. `"browser-view"`) and the existing eval bridge can target it.**
  - the `eval_and_await` round-trip returns data via the `mcp_result` Tauri command (`src-tauri/src/lib.rs:1684`) keyed by a correlation id (eval is fire-and-forget; the injected JS invokes `__TAURI_INTERNALS__.invoke('mcp_result', {...})` back to Rust).
- **Init-script injection on page load (how `__o8BrowserAgent` gets into the child page):**
  - `.on_page_load(...)` hook at `src-tauri/src/lib.rs:3660` (checks `webview.label()`), firing `WebviewLatch` (`src-tauri/src/webview_latch.rs`) which does `webview.eval(js)`. Add a branch that injects the in-page agent when `webview.label() == "browser-view"`.
- **The in-page agent to inject:** `src/lib/browser-agent/page-agent.ts` — `installBrowserAgent()` installs `window.__o8BrowserAgent` (read/click/type/probe/grab). This SAME code becomes the child webview's init script (serialize it / load it as an init script string). Grab uses `src/lib/browser/grab.ts` (`buildGrabbedElement`, `GRAB_PAYLOAD_SOURCE`) + `src/lib/browser/selector.ts` — already injectable sources.
- **Native NSWindow access (macOS):** `round_window_corners` at `lib.rs:3106` shows `win.ns_window()` + `objc2 msg_send` — use for child-window level/`addChildWindow:` so it tracks the main window on move.
- **The panel to gut:** `src/components/desktop/O8BrowserPane.tsx` (the iframe + proxy + engine fallback all live here); mounted by `src/components/desktop/O8Panel.tsx` (two mount sites). `src/components/desktop/DesignModeOverlay.tsx` + `src/hooks/useDesignMode.ts` are the grab entry; `src/lib/mcp/o8-webview-tools.ts` has the `o8_browser_*` verbs + `/api/browser/agent` route.

---

## Build stages (each tsc-clean + committed + pushed; NO ship)

**STAGE 1 — Rust: a positioned child `WebviewWindow`.**
Add a `browser_view` Rust module (copy `dock_window.rs`). Commands (register in `lib.rs` invoke_handler):
- `browser_view_open(url, x, y, w, h)` — create (if absent) a frameless `WebviewWindowBuilder` labeled `"browser-view"`, `decorations(false)`, navigate to `url` (`WebviewUrl::External`), position/size over the rect; make it a macOS child window of `main` (`addChildWindow:`) so it tracks. If present, navigate + reposition.
- `browser_view_set_rect(x, y, w, h)` — reposition/resize (the panel's ResizeObserver/scroll/move calls this). Convert CSS px → physical via `scale_factor()` like `reposition()`.
- `browser_view_navigate(url)`, `browser_view_close()`, `browser_view_hide()`, `browser_view_show()`.
Verify: a child window appears over the panel rect and tracks resize. (No injection yet.)

**STAGE 2 — Rust: inject `__o8BrowserAgent` into the child page.**
Extend `.on_page_load` (`lib.rs:3660`) — when `webview.label() == "browser-view"` and event is `Started`, `eval` the in-page agent install script (build it from `page-agent.ts` — e.g. a bundled string, or an init script registered at builder time via `.initialization_script(...)`). After this, `eval_and_await(label="browser-view", …)` can read the page (any origin). Verify: eval `document.title` into the child window returns the real page title for a cross-origin localhost app.

**STAGE 3 — Panel: placeholder + position sync.**
In `O8BrowserPane.tsx`, replace the iframe with a **placeholder div** at the content rect. A `ResizeObserver` on it + a window move/resize listener `invoke('browser_view_set_rect', rect)` (use `getBoundingClientRect()` → pass CSS px; Rust applies scale factor). On mount/url-change `invoke('browser_view_open', {url, ...rect})`; on tab-switch navigate; on unmount/hide `browser_view_hide()`. URL bar / tabs / reload all drive `browser_view_navigate`. Keep the agent-glow + the chrome. Verify: localhost:3000 (Clerk) renders **smoothly** in the panel, human-interactive natively, and tracks panel resize.

**STAGE 4 — Grab + agent wiring to the child webview.**
Route the panel's grab + `o8_browser_*` to eval into the `"browser-view"` label (instead of the in-page iframe path). Design Mode grab over the panel: when the pointer is over the placeholder rect, send a grab to the child webview (map CSS coords → the child page's coords; the child's `__o8BrowserAgent.grab`/an `elementFromPoint`-based grab returns the `GrabbedElement`). `o8_browser_read/click/type/grab` with the panel surface target the child webview label via the existing eval bridge. Verify: Design Mode grab on a Clerk app returns a real `GrabbedElement`; `o8_browser_grab` works.

**STAGE 5 — Occlusion (the real native cost).**
A native webview composites *above* o8's web content, so any o8 overlay over the panel rect is hidden behind it. Snapshot-swap: on a **finite trigger list** — ⌘K command palette, ⌘⇧K quick-action palette, any centered modal/dialog, the dictation pill, settings, the right-panel collapse, **and during live panel drag/resize** — call `browser_view_hide()` and paint a last-frame screenshot (o8 already screenshots webviews) into the placeholder; `browser_view_show()` + reposition on close/settle. Enumerate the triggers; don't leave it open-ended.

**STAGE 6 — Feature flag + retire the laggy path.**
Gate the whole native-webview path behind an operator setting (default OFF until it passes dogfood; the proxy/iframe + engine stay the default meanwhile). Once dogfooded smooth on Clerk + plain apps: flip default ON, and **delete the engine-JPEG `O8EnginePane` + `/api/browser/engine/act` + the engine coord methods** (the laggy fallback), keeping the engine tier only for external-URL agent use. Final orphan grep.

---

## Hard gotchas (the brainstormer flagged these — they ARE the work)

- **Retina coords:** physical px = CSS px × `scaleFactor`. The hit-rect round-trip + any coord mapping must convert (same gotcha documented for `o8_view_screenshot`).
- **Occlusion is unavoidable natively** — snapshot-swap on the finite trigger list is the mechanism. This is the largest cost; budget for it.
- **Drag/resize jank:** during live panel drag, hide the webview + show the snapshot, reposition on settle (don't reposition the native window every frame).
- **Child-window tracking:** `addChildWindow:` so it moves with the main window; also reposition on monitor/scale change.
- **Multi-tab:** one `"browser-view"` window navigated per active tab (or one per tab — start with one, navigate on tab switch). The non-active-tab state is the snapshot.
- **Lifecycle:** close/hide the child window when the Browser tab isn't visible, the panel is collapsed, or the app backgrounds.
- **Don't break `o8_view_*`:** those target `"main"`. The new child is `"browser-view"`. The `default_webview_label` is `"main"` (`tauri-plugin-mcp` config at `lib.rs:~3650`) — keep it.

## Implementation constraints
- Inline styles only (no CSS classes/shorthand), theme tokens (`var(--t-*)`), `as React.CSSProperties` for vendor props.
- `npx tsc --noEmit` before every commit; `npm test` at the end. Rust: `cargo build` (and `cargo test --lib` from `src-tauri/`).
- Native behavior must be verified in a built Tauri app because the child webview does not exist in `next dev`.

## Definition of done
localhost:3000 (Clerk) renders **smoothly** in the Browser pane (native), human-interactive natively, **grab works** (Design Mode + `o8_browser_grab`) via eval-into-`browser-view`, the webview tracks panel resize/move, occlusion handled for the major overlays, feature-flagged, the engine-JPEG retired once proven, tsc + tests + cargo green, each stage committed + pushed. One smooth surface for plain AND auth-gated local apps.
