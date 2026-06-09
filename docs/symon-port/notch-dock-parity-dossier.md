# Symon Notch-Dock HUD — Parity Dossier for the o8 Port

**Audience:** the o8 agent porting Symon's top-of-screen HUD into o8 (cortex-ide).
**Goal:** pixel-and-behavior parity with shipped Symon. The dock must hang **flush from the top edge of the screen, dead-center, with no window chrome, over every other app**, and morph between states with one smooth spring — exactly like the source app.

**Source of truth:** `~/aqua-color` (Tauri v2 + Svelte). o8 is also Tauri v2, so the **Rust/NSWindow mechanics port 1:1**; only the frontend layer (Svelte → React/Next) changes. Every value below is lifted from the live, shipped code — file:line index is at the bottom. When in doubt, read the source, not this doc.

> o8 house rule reminder: **inline styles only, no CSS classes.** The CSS below is the *contract* (exact values). Apply them however o8 does it — inline style objects are fine; the numbers are what matter.

---

## 0. How to use this

1. Read §1–§3 to understand what's broken and why.
2. Implement §4 (the window contract) **first** — that's what o8 got most wrong, and nothing else looks right until the window is a borderless, transparent, top-pinned, click-through overlay at level 25.
3. Implement §5–§6 (the visual morph spec) to match the look.
4. Run §7 (the parity checklist) before calling it done.

Reference screenshots of the **current broken o8 state** are in `docs/o8-parity-frames/` next to this file.

---

## 1. TL;DR diagnosis

The o8 port is rendering the HUD as **an ordinary, decorated, resizable, opaque window floating below the menubar**, off-center to the right, with free-floating "card" styling (all corners rounded, drop shadow, full borders) and wrong colors on the confirmation capsule.

The shipped Symon HUD is the opposite of all of that: **one transparent, borderless, non-resizable, click-through window, pinned to the top-center of the display at NSWindow level 25 (above the menu bar), containing a single element that *hangs from the very top edge* (square top corners, rounded bottom only) and morphs between states via a CSS spring.** The native window never resizes per state — it's a fixed 440×360 transparent box and the visible dock grows/shrinks *inside* it with CSS.

Fix the window contract and the geometry, then match the per-state styling. Details below.

---

## 2. The mental model

```
            ┌─ screen top edge (y = monitor origin) ───────────────────┐
            │                  ▼ dock hangs FROM here                   │
            │              ┌───────────┐   ← square top corners         │
   menu bar │              │  ░░░░░░░  │      (border-radius: 0 0 R R)   │
 (level 24) │              └─────╮ ╭───┘   ← rounded bottom only        │
            │   level 25 ⇒ the dock sits ABOVE the menu bar & all apps  │
```

- **One window** (label `symon_assistant`), **fixed 440×360**, transparent, borderless, no shadow, not resizable, always-on-top, `skipTaskbar`, **level 25**, positioned **top-center** with its top at the screen's top edge.
- **One morphing element** inside it (the "dock"). It changes `width`/`height`/`border-radius`/`background` between states on a spring. **The native window does not resize per state** — that snap is exactly what made an earlier build feel worse than the prototype.
- The window content is **click-through except on the dock itself**: the full-bleed wrapper is `pointer-events: none`; only the dock is `pointer-events: auto`.
- It **hangs from the top edge** — square top corners, rounded bottom — so it reads as part of the notch, not a floating card.

Canonical prototype to feel it: open `~/aqua-color/notch-dock-prototype.html` in a browser. That HTML/CSS/JS file is the locked design spec; the app was built to match it.

---

## 3. What's wrong in the recording → root cause → fix

| # | Symptom in the video | Root cause | Fix |
|---|---|---|---|
| 1 | **Dashed selection border with 8 resize handles** around the whole top region (frames `bad__window-chrome*`) | The HUD window is **decorated / resizable / opaque** — standard window chrome, not an overlay | Window must be `decorations:false, transparent:true, shadow:false, resizable:false` + native `setBackgroundColor(clearColor)` + `setOpaque(false)`. See §4a/§4b. |
| 2 | Dock **floats below the top edge**, **all corners rounded**, **drop shadow**, full border ring → looks like a floating card | Styled as a free element instead of hanging from the notch; window positioned with a top gap | Position window top at `y = monitor.origin_y` (the very top); `align-items: flex-start` so the dock touches y=0; `border-radius: 0 0 R R`; `border-top: none`. See §4d/§5. |
| 3 | Dock is **off-center, shifted right** | Window x not centered (or dock not centered in window) | `x = origin_x + (monitor_w − window_w)/2`; wrapper `justify-content: center`. See §4d. |
| 4 | **Two surfaces visible at once** (idle sliver top-center + a second gradient blob lower-right) | More than one surface is being rendered/positioned; the window holds more than the single morphing dock | Render **exactly one** morphing element. One window, one dock. Park/hide everything else. See §2, §4e. |
| 5 | **"Pasted" capsule is wrong**: gray fill, full thin green border ring, **dark** text, rounded all corners, floating | Done/confirmation state styled from scratch instead of the spec | It's the **darkened-brand capsule**: 420×44, `border-radius: 0 0 20px 20px`, brand gradient under a dark scrim, **white** text, and a **green inset underline** (`inset 0 -2px 0 #43d6a0`) — *not* a green border ring. See §6. |
| 6 | Sits **under** the menu bar / behaves like a normal app window | Window level is default (normal) | `NSWindow setLevel(25)`. Optional: collection behavior to also clear other Spaces & fullscreen apps. See §4c/§4g. |

---

## 4. The window contract  *(implement this first)*

### 4a. Tauri window config (`tauri.conf.json`)

The HUD window in Symon is label `symon_assistant`. Match these flags exactly:

```json
{
  "label": "symon_assistant",
  "url": "symon.html",
  "width": 26, "height": 26,            // seed size; resized to 440×360 at startup
  "minWidth": 26, "minHeight": 26,
  "resizable": false,
  "decorations": false,                 // ← no title bar / no frame
  "transparent": true,                  // ← requires macOSPrivateApi (below)
  "alwaysOnTop": true,
  "shadow": false,                      // ← no window drop shadow
  "skipTaskbar": true,
  "center": false,
  "visible": true
}
```

And at the **app** level — non-negotiable for transparency on macOS:

```json
"app": { "macOSPrivateApi": true, "windows": [ ... ] }
```

> Without `macOSPrivateApi: true` + the native `clearColor` step in §4b, production builds get the white-flash / opaque-background bug (tauri#13070). Symon hit this; the clearColor recipe is the fix.

### 4b. Native NSWindow setup (Rust, runs in the Tauri `setup` hook, main thread)

Applied to the HUD window at startup (Symon does it for both the pill and `symon_assistant`):

```rust
#[cfg(target_os = "macos")]
{
    use objc2_app_kit::{NSColor, NSWindow};
    let ns_window_ptr = webview.ns_window().unwrap() as *mut NSWindow;
    unsafe {
        let ns_window = &*ns_window_ptr;
        let clear = NSColor::clearColor();
        ns_window.setBackgroundColor(Some(&clear)); // defeats the white-flash bug
        ns_window.setOpaque(false);
        ns_window.setLevel(3);                       // floating; bumped to 25 for notch (§4c)
    }
}
```

### 4c. "Over all other apps" — the window level

macOS window levels that matter:
- **3** = `NSFloatingWindowLevel` (normal always-on-top)
- **24** = main menu bar
- **25** = `NSStatusWindowLevel` → **just above the menu bar**

The notch HUD runs at **level 25** so it hangs over the menu bar and above every normal app window. Symon flips between 25 (notch mode) and 3 (legacy bottom pill) via one helper. **NSWindow mutations must run on the main thread:**

```rust
/// Level 25 (just over the menu bar's level 24) makes the HUD hang above the
/// menu bar at the true top of the screen. Must run on the main thread.
#[cfg(target_os = "macos")]
pub(crate) fn set_macos_window_level(window: &tauri::WebviewWindow, level: isize) {
    let win = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2_app_kit::NSWindow;
        if let Ok(ptr) = win.ns_window() {
            let ptr = ptr as *mut NSWindow;
            if !ptr.is_null() {
                unsafe { (*ptr).setLevel(level) };
            }
        }
    });
}
```

Call `set_macos_window_level(&window, 25)` whenever you show/resize the HUD.

### 4d. Top-center, flush-to-top positioning (the geometry o8 got wrong)

Position the window so its **top edge = the screen's top edge** and it's **horizontally centered**. Work in *logical* points (divide physical by scale factor):

```rust
if let Ok(Some(monitor)) = window.current_monitor() {
    let scale     = monitor.scale_factor();
    let origin_x  = monitor.position().x as f64 / scale;
    let origin_y  = monitor.position().y as f64 / scale;   // top of the display
    let logical_w = monitor.size().width  as f64 / scale;

    let x = origin_x + (logical_w - window_width) / 2.0;     // centered
    let y = origin_y;                                        // flush to the very top
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}
set_macos_window_level(window, 25);
```

Two things make it "hang from the notch" rather than "float below the bar":
1. **Window `y = origin_y`** (top of the monitor), and
2. the dock inside is top-anchored (`align-items: flex-start`) with **square top corners** (`border-radius: 0 0 R R`, `border-top: none`).

### 4e. Fixed window + CSS morph (do NOT resize the window per state)

At startup the frontend sizes the HUD window once to the **panel max, 440×360**, and leaves it there:

```ts
// front-end, on mount
await invoke("resize_symon_window", { height: 360, width: 440 });
```

From then on, **only the inner dock element changes size** (via CSS transition). The native window stays 440×360. This is the single most important "feel" decision — per-state native resize caused a visible snap and is why an earlier app build felt worse than the prototype. Idle/listening/done states are small visually because the *dock* is small inside the fixed transparent window, not because the window shrank.

> Symon keeps `resize_symon_window` around for vertical-clamp edge cases (clamps height ≤ 640), but the steady-state contract is: **fixed window, CSS-morphing dock.**

### 4f. Click-through layering

The window is interactive **only on the dock**. Everything else is transparent and passes clicks through:

```css
.wrap {                 /* fills the 440×360 window */
  position: absolute; inset: 0;
  display: flex;
  justify-content: center;   /* center horizontally */
  align-items: flex-start;   /* hang from the top edge */
  pointer-events: none;      /* empty area = click-through */
}
.dock { pointer-events: auto; }   /* only the dock catches the mouse */
```

Keep native cursor events **enabled** on the window (`set_ignore_cursor_events(false)`); the CSS `pointer-events` split does the rest. (Symon's separate full-screen annotation `overlay` window is the one that uses `set_ignore_cursor_events(true)` — don't confuse the two.)

### 4g. (Enhancement) truly above *everything* — other Spaces & fullscreen apps

Level 25 puts the HUD over normal apps and the menu bar **on the current Space**. Shipped Symon stops there. If o8 wants it to also stay visible across **all Spaces** and over **other apps in fullscreen**, add collection behavior once, on the main thread:

```rust
use objc2_app_kit::NSWindowCollectionBehavior;
unsafe {
    ns_window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary,
    );
}
```

This is the standard Dynamic-Island/overlay recipe. Treat it as a deliberate upgrade beyond current Symon parity, not a bug fix.

---

## 5. The visual morph spec

### Shared constants (use everywhere — this is the brand)

- **Brand gradient** (idle / listening / done / dot): `linear-gradient(100deg, #aecdff 0%, #d7c2f1 46%, #f7d9bf 100%)`
- **Dark scrim** (over the brand gradient on listening/thinking/done, so the wave pops): `linear-gradient(rgba(13,11,26,0.5), rgba(13,11,26,0.5))` layered *on top of* the brand gradient.
- **Spring (the "feel"):** `cubic-bezier(0.22, 1, 0.36, 1)` — overshoot-free.
- **Transitions on the dock:**
  ```css
  transition:
    width 0.5s  cubic-bezier(0.22,1,0.36,1),
    height 0.5s cubic-bezier(0.22,1,0.36,1),
    border-radius 0.46s cubic-bezier(0.22,1,0.36,1),
    background 0.4s ease,
    box-shadow 0.4s ease;
  ```
- **Done/success green:** `#43d6a0` (used as an **inset underline**, never a full ring).
- **Two wave primitives, reused for continuity:**
  - **EQ "media wave"** — ~30 thin gaussian bars, audio-driven, gradient `#88D1F1 → #B1B4E5 → #F5B8C4 → #F4C977`. Used for anything with **audio** (listening, speaking). (`SymonPillWaveform`)
  - **"Squiggle"** — used for anything **processing** (thinking, polishing). (`SquiggleLoader`)

### Per-state dock geometry (exact, from `NotchSurface.svelte`)

The dock always has: `overflow: hidden; display: flex; flex-direction: column; border-top: none;` and square top corners. Only the values below change per state.

| State | width × height | border-radius | background | border | box-shadow | extras |
|---|---|---|---|---|---|---|
| **idle** | 128 × 16 | `0 0 14px 14px` | brand gradient | `1px rgba(255,255,255,.45)` | `0 6px 20px rgba(0,0,0,.28), inset 0 -2px 6px rgba(120,110,160,.22)` | `backdrop-filter: blur(10px) saturate(160%)` — a small sliver hanging from the notch |
| **listening / thinking** | 248 × 40 | `0 0 20px 20px` | dark scrim **over** brand gradient | `1px rgba(255,255,255,.4)` | `0 8px 22px rgba(40,40,80,.3)` | centered; holds the EQ wave (133×22) or squiggle (150×26) |
| **done** | 420 × 44 | `0 0 20px 20px` | dark scrim **over** brand gradient | `1px rgba(255,255,255,.4)` | `0 8px 22px rgba(40,40,80,.3), inset 0 -2px 0 #43d6a0` | white text; see §6 |
| **answer / speaking / longform (panel)** | 440 × 360 | `0 0 26px 26px` | `var(--symon-surface-bg)` | `1px var(--symon-surface-border)` | `var(--symon-surface-shadow)` | `backdrop-filter: blur(34px) saturate(140%)`; themed by surface selector (§5 surface tokens) |

Idle sliver, verbatim:

```css
.dock--idle {
  width: 128px; height: 16px;
  border-radius: 0 0 14px 14px;            /* flush top, rounded bottom */
  background: linear-gradient(100deg, #aecdff 0%, #d7c2f1 46%, #f7d9bf 100%);
  border: 1px solid rgba(255,255,255,0.45);
  border-top: none;
  box-shadow: 0 6px 20px rgba(0,0,0,0.28), inset 0 -2px 6px rgba(120,110,160,0.22);
  backdrop-filter: blur(10px) saturate(160%);
  -webkit-backdrop-filter: blur(10px) saturate(160%);
}
```

### Panel surface tokens (the themed glass for answer/speaking)

The panel reads three CSS vars from the selected surface. Default surface = **Apple Glass**:

| var | Apple Glass value |
|---|---|
| `--symon-surface-bg` | `rgba(246, 248, 251, 0.6)` |
| `--symon-surface-border` | `rgba(255, 255, 255, 0.5)` |
| `--symon-surface-shadow` | `0 18px 40px rgba(15, 23, 42, 0.18)` |

Other shipped surfaces (id → bg / border / shadow), if o8 wants the selector:
- **Midnight Glass** `midnight` → `rgba(8,14,24,0.88)` / `rgba(255,255,255,0.08)` / `0 16px 34px rgba(3,8,17,0.22)`
- **Frost Light** `frost` → `rgba(248,250,253,0.9)` / `rgba(255,255,255,0.62)` / `0 16px 36px rgba(148,163,184,0.18)`
- **Mist Glass** `mist` → `rgba(255,255,255,0.28)` / `rgba(255,255,255,0.24)` / `0 16px 34px rgba(15,23,42,0.14)`

Panel uses `backdrop-filter: blur(34px) saturate(140%)` regardless of surface.

---

## 6. The "done / Pasted" flash (o8 botched this specifically)

When dictation finishes and pastes, the dock flashes the polished result, then collapses. The capsule is the **darkened-brand** style with a **green underline**, **white** text — NOT a gray box with a green border.

```css
.dock--done {
  width: 420px; height: 44px;
  border-radius: 0 0 20px 20px;           /* flush top */
  padding: 0 18px;
  align-items: center; justify-content: center;
  border: 1px solid rgba(255,255,255,0.4);
  border-top: none;
  background:
    linear-gradient(rgba(13,11,26,0.5), rgba(13,11,26,0.5)),   /* dark scrim */
    linear-gradient(100deg, #aecdff 0%, #d7c2f1 46%, #f7d9bf 100%);  /* brand */
  box-shadow: 0 8px 22px rgba(40,40,80,0.3), inset 0 -2px 0 #43d6a0; /* green underline */
}
.dock--done .text {
  margin: 0; font-size: 13px; font-weight: 300; letter-spacing: -0.1px;
  color: #fff; text-shadow: 0 1px 6px rgba(0,0,0,0.35);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
}
```

Diff vs. what o8 currently renders:
- ❌ gray vertical-gradient fill → ✅ brand gradient under a dark scrim
- ❌ full thin green **border ring** → ✅ green `inset 0 -2px 0 #43d6a0` **underline** only
- ❌ dark text → ✅ **white** text with soft shadow
- ❌ rounded all corners, floating → ✅ `0 0 20px 20px`, flush to top

---

## 7. Parity verification checklist

Window / behavior:
- [ ] No title bar, no frame, **no dashed border, no resize handles** anywhere.
- [ ] Background fully transparent — no opaque/gray rectangle behind the dock.
- [ ] Dock **top edge touches the screen top edge** (no gap under the menubar).
- [ ] Dock is **horizontally centered** on the display.
- [ ] HUD renders **above the menu bar** and above other app windows (level 25).
- [ ] Empty area around the dock is **click-through**; only the dock is interactive.
- [ ] **Native window does not resize** as states change — only the inner dock morphs.
- [ ] Exactly **one** surface visible at any time (no stray second blob).

Look:
- [ ] **Idle** = 128×16 brand sliver, square top / rounded bottom, hanging from the notch.
- [ ] **Listening** = 248×40 darkened-brand capsule with the EQ wave; **thinking** = squiggle.
- [ ] **Done/Pasted** = 420×44, white text, green inset underline, brand gradient (see §6).
- [ ] **Panel** = 440×360 themed glass, `0 0 26px 26px`, `blur(34px)`.
- [ ] State changes ride the spring `cubic-bezier(0.22,1,0.36,1)` — no snap, no jump.

Cross-check against `~/aqua-color/notch-dock-prototype.html` (open in a browser) and the shipped app side-by-side.

---

## 8. Source-of-truth index (read these in `~/aqua-color`)

| What | File:line |
|---|---|
| Window flags (`symon_assistant`, transparent/borderless/no-shadow) | `src-tauri/tauri.conf.json:66-82` + `macOSPrivateApi` `:32` |
| Native transparency setup (clearColor / setOpaque / setLevel) | `src-tauri/src/lib.rs:3435-3451` |
| Window-level helper (`setLevel`, level 25 vs 3) | `src-tauri/src/commands.rs:1721-1741` |
| Top-center + flush-top positioning + level on resize | `src-tauri/src/commands.rs:1531-1564` (pill) and `:1695-1718` (assistant) |
| Fixed-window sizing at startup (`resize_symon_window(360,440)`) | `src/SymonApp.svelte:309`; command at `src-tauri/src/commands.rs:1673-1719` |
| The morphing dock — markup + every per-state CSS value | `src/lib/components/NotchSurface.svelte` (idle `:192`, listening/thinking `:205`, done `:223`, panel `:251`, wrap/click-through `:165-172`) |
| Surface tokens (Apple Glass etc.) + CSS-var mapping | `src/lib/pillSurfaces.ts:16-92` |
| Wave primitives | `src/lib/components/SymonPillWaveform.svelte`, `src/lib/components/SquiggleLoader.svelte` |
| Locked design prototype (open in a browser) | `notch-dock-prototype.html` (repo root) |
| Click-through / cursor-events note (and the separate annotation overlay) | `src-tauri/src/lib.rs:3468`; overlay window `src-tauri/src/overlay.rs:320-360` |

Broken-state reference frames (this port): `docs/o8-parity-frames/`.
