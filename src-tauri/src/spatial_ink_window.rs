//! Symon Spatial Context — the draw-on-screen ink overlay window.
//!
//! A sibling of `agent_partials_window` / `dock_window`: a transparent,
//! all-spaces, always-on Tauri window — label **`spatial-ink`**, NEVER `main`
//! (same label-discipline invariant as the dock/HUD). It loads the bundled-Next
//! route `/spatial-ink` and lets the operator draw glowing strokes anywhere on
//! the LIVE screen while holding Right-Option (Symon push-to-talk). On release,
//! a screenshot + the strokes ride the brain turn with the spoken command, so
//! "why does THIS look off?" + a circle tells the model exactly where to look.
//!
//! Level 24 (one BELOW the partials HUD at 25) so the HUD bar reads OVER the
//! ink, but above normal app windows so the operator draws over everything.
//!
//! ── CRITICAL mouse-capture protocol ──
//! The window is CLICK-THROUGH (`set_ignore_cursor_events(true)`) at ALL times
//! EXCEPT during an agent hold. `begin_agent_dictation` calls `arm(&app)`
//! (capture ON — `set_ignore_cursor_events(false)` + orderFront nonactivating);
//! EVERY teardown path (finalize, error, cancel, session-idle) calls `disarm`
//! (capture OFF). A stuck non-click-through invisible full-screen window would
//! brick the operator's mouse, so disarm is belt-and-suspenders:
//!   1. Rust callers disarm on every terminal path (finalize / discard / error).
//!   2. The page requests disarm (`o8:spatial-ink-disarm-request`) on ANY
//!      terminal STT event.
//!   3. A 90s Rust safety timer from `arm` auto-disarms if nothing else did.
//! Any ONE of the three is sufficient; all three together make a stuck capture
//! effectively impossible.
//!
//! ── Capture + composite flow ──
//! On the FIRST stroke the page emits `o8:spatial-ink-first-stroke`; Rust
//! captures the marked monitor at full-res (before the ink renders — the screen
//! is what the operator is pointing at) and stashes it. On the STT `final`
//! event the page emits `o8:spatial-ink-strokes` with the normalized strokes.
//! At finalize, `take_spatial_context()` burns the strokes into the screenshot
//! and cuts a full-res crop of the marked region (see `screen::composite_strokes`).

#[cfg(target_os = "macos")]
pub const SPATIAL_INK_LABEL: &str = "spatial-ink";

#[cfg(target_os = "macos")]
mod imp {
    use super::SPATIAL_INK_LABEL;
    use crate::agent::screen;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// Placeholder frame at boot; `arm` sizes it to the cursor's monitor.
    const PLACEHOLDER_W: f64 = 800.0;
    const PLACEHOLDER_H: f64 = 600.0;
    /// Belt-and-suspenders: never let the capture-mouse state persist longer
    /// than this after an arm, no matter what fails downstream.
    const SAFETY_DISARM_SECS: u64 = 90;

    /// True while an agent hold has the ink window capturing the mouse.
    static ARMED: AtomicBool = AtomicBool::new(false);
    /// Bumped on every `arm`; the 90s safety thread only fires if its generation
    /// still matches (so a re-arm cancels the previous timer).
    static ARM_GEN: AtomicU64 = AtomicU64::new(0);
    static OVERLAY_CHANGE: Mutex<()> = Mutex::new(());

    /// Single-slot stash for the current (serial, push-to-talk) agent session:
    /// the full-res capture taken at first stroke + the normalized strokes the
    /// page reports at `final`. `arm` resets it; `take_spatial_context` drains it.
    struct Stash {
        /// Each inner Vec is one polyline of NORMALIZED (0..1) points.
        strokes: Option<Vec<Vec<(f64, f64)>>>,
        capture: Option<screen::RawCapture>,
        /// A capture subprocess is in flight (started on first stroke).
        capturing: bool,
        first_stroke_seen: bool,
        raw_strokes: serde_json::Value,
        generation: u64,
        visual_id: Option<String>,
    }

    impl Stash {
        const fn new() -> Self {
            Stash {
                strokes: None,
                capture: None,
                capturing: false,
                first_stroke_seen: false,
                raw_strokes: serde_json::Value::Null,
                generation: 0,
                visual_id: None,
            }
        }
    }

    static STASH: Mutex<Stash> = Mutex::new(Stash::new());

    fn lock_stash() -> std::sync::MutexGuard<'static, Stash> {
        STASH.lock().unwrap_or_else(|p| p.into_inner())
    }

    // ── Payload types (JS → Rust events) ──

    #[derive(serde::Deserialize, serde::Serialize)]
    struct InkPoint {
        x: f64,
        y: f64,
        #[serde(default)]
        t: f64,
        // `t` (timestamp) is reported but unused server-side.
    }

    #[derive(serde::Deserialize, serde::Serialize)]
    struct InkStroke {
        #[serde(default)]
        points: Vec<InkPoint>,
    }

    #[derive(serde::Deserialize)]
    struct StrokesPayload {
        #[serde(default, rename = "visualCaptureId")]
        visual_id: Option<String>,
        #[serde(default)]
        strokes: Vec<InkStroke>,
    }

    impl StrokesPayload {
        fn into_points(self) -> Vec<Vec<(f64, f64)>> {
            self.strokes
                .into_iter()
                .map(|s| s.points.into_iter().map(|p| (p.x, p.y)).collect())
                .filter(|v: &Vec<(f64, f64)>| !v.is_empty())
                .collect()
        }
    }

    // ── Window creation ──

    pub fn create(app: &tauri::AppHandle, api_port: u16) {
        use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

        if app.get_webview_window(SPATIAL_INK_LABEL).is_some() {
            return;
        }

        let base = match crate::dev_frontend::from_env() {
            Ok(Some(dev)) => {
                log::info!("[spatial-ink] dev-bridge: loading from {}", dev.origin());
                dev.origin().to_string()
            }
            _ => format!("http://127.0.0.1:{}", api_port),
        };
        let url = format!("{}/spatial-ink", base);
        let parsed = match url.parse() {
            Ok(u) => u,
            Err(e) => {
                log::warn!("[spatial-ink] bad url {url}: {e}");
                return;
            }
        };

        let window =
            WebviewWindowBuilder::new(app, SPATIAL_INK_LABEL, WebviewUrl::External(parsed))
                .title("o8 spatial ink")
                .inner_size(PLACEHOLDER_W, PLACEHOLDER_H)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .shadow(false)
                .skip_taskbar(true)
                .focused(false)
                .visible(true)
                .disable_drag_drop_handler()
                .build();

        let window = match window {
            Ok(w) => w,
            Err(e) => {
                log::warn!("[spatial-ink] failed to build window: {e}");
                return;
            }
        };

        apply_macos_recipe(&window);
        // CLICK-THROUGH at rest — every click passes through until `arm`.
        let _ = window.set_ignore_cursor_events(true);
        order_front_nonactivating(&window);
        log::info!("[spatial-ink] ink window created (always-on, click-through) → {url}");
    }

    /// Transparent + level-24 + nonactivating NSWindow recipe. Level 24 keeps it
    /// UNDER the partials HUD (25) so the HUD bar reads over the ink, and above
    /// normal app windows so the operator draws over everything. Main-thread only.
    fn apply_macos_recipe(window: &tauri::WebviewWindow) {
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            use objc2_app_kit::{NSColor, NSWindow, NSWindowCollectionBehavior};
            let Ok(ptr) = win.ns_window() else {
                return;
            };
            let ptr = ptr as *mut NSWindow;
            if ptr.is_null() {
                return;
            }
            // Safety: Tauri guarantees a live NSWindow for the window's lifetime;
            // this closure runs on the main thread.
            unsafe {
                let ns_window = &*ptr;
                let clear = NSColor::clearColor();
                ns_window.setBackgroundColor(Some(&clear));
                ns_window.setOpaque(false);
                // One below the HUD (25) — ink renders UNDER the partials bar.
                ns_window.setLevel(24);
                ns_window.setHidesOnDeactivate(false);
                ns_window.setCollectionBehavior(
                    NSWindowCollectionBehavior::CanJoinAllSpaces
                        | NSWindowCollectionBehavior::Stationary
                        | NSWindowCollectionBehavior::FullScreenAuxiliary
                        | NSWindowCollectionBehavior::IgnoresCycle,
                );
            }
        });
    }

    fn order_front_nonactivating(window: &tauri::WebviewWindow) {
        let _ = window.show();
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            use objc2_app_kit::NSWindow;
            if let Ok(ptr) = win.ns_window() {
                let ptr = ptr as *mut NSWindow;
                if !ptr.is_null() {
                    // Safety: live NSWindow, main thread.
                    unsafe {
                        (*ptr).orderFrontRegardless();
                    }
                }
            }
        });
    }

    /// Size + position the window to fully cover the monitor under the cursor.
    /// Logical coordinates; runs on the main thread (NSScreen reads touch AppKit).
    fn reposition_to_cursor(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
        let win = window.clone();
        let app = app.clone();
        let _ = window.run_on_main_thread(move || {
            let cursor = app.cursor_position().ok();
            let monitors = app.available_monitors().unwrap_or_default();
            let monitor = cursor
                .and_then(|c| {
                    monitors
                        .iter()
                        .find(|m| {
                            let p = m.position();
                            let s = m.size();
                            c.x >= p.x as f64
                                && c.x < (p.x + s.width as i32) as f64
                                && c.y >= p.y as f64
                                && c.y < (p.y + s.height as i32) as f64
                        })
                        .cloned()
                })
                .or_else(|| app.primary_monitor().ok().flatten())
                .or_else(|| monitors.first().cloned());
            let Some(monitor) = monitor else {
                return;
            };
            let scale = monitor.scale_factor();
            let mon_x = monitor.position().x as f64 / scale;
            let mon_y = monitor.position().y as f64 / scale;
            let mon_w = monitor.size().width as f64 / scale;
            let mon_h = monitor.size().height as f64 / scale;
            let _ = win.set_size(tauri::LogicalSize::new(mon_w, mon_h));
            let _ = win.set_position(tauri::LogicalPosition::new(mon_x, mon_y));
        });
    }

    // ── Arm / disarm (mouse-capture protocol) ──

    /// Begin an agent hold: reset the stash, cover the cursor's monitor, CAPTURE
    /// the mouse, order front nonactivating, and arm the 90s safety auto-disarm.
    pub fn arm(app: &tauri::AppHandle) {
        let _ = arm_owned(app, None);
    }

    pub fn arm_visual(app: &tauri::AppHandle, id: String) -> Option<u64> {
        arm_owned(app, Some(id))
    }

    fn arm_owned(app: &tauri::AppHandle, visual_id: Option<String>) -> Option<u64> {
        use tauri::{Emitter, Manager};
        let _change = OVERLAY_CHANGE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // #2147 — quiet mode owns overlay visibility for its duration. Arming
        // would cover the presenter's whole monitor with a capture layer.
        if crate::presentation::overlay_show_blocked() {
            return None;
        }
        let (generation, superseded) = {
            let mut stash = lock_stash();
            if visual_id.is_some() && is_armed() {
                return None;
            }
            let generation = ARM_GEN.fetch_add(1, Ordering::SeqCst) + 1;
            let superseded = stash.visual_id.take();
            *stash = Stash {
                generation,
                visual_id,
                ..Stash::new()
            };
            ARMED.store(true, Ordering::SeqCst);
            (generation, superseded)
        };
        if let Some(id) = superseded {
            let payload = serde_json::json!({ "id": id });
            let _ = app.emit_to("main", "o8:visual-capture-superseded", &payload);
            let _ = app.emit_to(SPATIAL_INK_LABEL, "o8:visual-capture-superseded", &payload);
        }

        if let Some(win) = app.get_webview_window(SPATIAL_INK_LABEL) {
            reposition_to_cursor(app, &win);
            apply_macos_recipe(&win);
            // CAPTURE the mouse — pointer events now reach the ink page.
            let _ = win.set_ignore_cursor_events(false);
            order_front_nonactivating(&win);
            log::info!("[spatial-ink] armed (mouse capture on)");
        } else {
            log::warn!("[spatial-ink] arm: window missing");
        }

        // Belt-and-suspenders 90s safety: a stuck non-click-through full-screen
        // window would brick the mouse — this can never let that persist.
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(SAFETY_DISARM_SECS));
            if ARMED.load(Ordering::SeqCst) && ARM_GEN.load(Ordering::SeqCst) == generation {
                log::warn!("[spatial-ink] 90s safety auto-disarm (no teardown fired)");
                disarm_visual(&app2, generation);
            }
        });
        Some(generation)
    }

    /// End the hold: restore click-through and tell the page to clear its canvas.
    /// Idempotent — safe to call from any teardown path, armed or not.
    pub fn disarm(app: &tauri::AppHandle) {
        let _ = disarm_owned(app, None);
    }

    pub fn disarm_visual(app: &tauri::AppHandle, expected: u64) -> bool {
        disarm_owned(app, Some(expected))
    }

    fn disarm_owned(app: &tauri::AppHandle, expected: Option<u64>) -> bool {
        use tauri::{Emitter, Manager};
        let _change = OVERLAY_CHANGE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if expected.is_some_and(|generation| generation != ARM_GEN.load(Ordering::SeqCst)) {
            return false;
        }
        let was_armed = ARMED.swap(false, Ordering::SeqCst);
        if let Some(win) = app.get_webview_window(SPATIAL_INK_LABEL) {
            // RESTORE click-through — clicks pass through again.
            let _ = win.set_ignore_cursor_events(true);
        }
        // Clear the page canvas (also its belt for a missed terminal STT event).
        let _ = app.emit_to(
            SPATIAL_INK_LABEL,
            "o8:spatial-ink-clear",
            serde_json::json!({}),
        );
        if was_armed {
            log::info!("[spatial-ink] disarmed (mouse capture off)");
        }
        true
    }

    /// Queue the visual UI begin before any later native owner can replace it.
    pub fn begin_visual_controls(
        app: &tauri::AppHandle,
        expected: u64,
        id: &str,
    ) -> Result<(), String> {
        use base64::Engine;
        use tauri::Emitter;
        let _change = OVERLAY_CHANGE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if generation() != expected || !is_armed() {
            return Err("The capture owner changed before drawing became ready.".into());
        }
        let background = {
            let stash = lock_stash();
            let capture = stash
                .capture
                .as_ref()
                .ok_or("The captured image is no longer available.")?;
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&capture.png_bytes)
            )
        };
        app.emit_to(
            SPATIAL_INK_LABEL,
            "o8:visual-capture-begin",
            serde_json::json!({ "id": id, "background": background }),
        )
        .map_err(|error| error.to_string())
    }

    pub fn is_armed() -> bool {
        ARMED.load(Ordering::SeqCst)
    }

    pub fn generation() -> u64 {
        ARM_GEN.load(Ordering::SeqCst)
    }

    pub fn capture_ready(expected: u64) -> bool {
        let stash = lock_stash();
        stash.generation == expected && !stash.capturing && stash.capture.is_some()
    }

    /// Pin the shared stash before starting the image subprocess.
    pub fn prime_capture(app: &tauri::AppHandle, expected: u64) {
        on_first_stroke(app, Some(expected));
    }

    /// A correlated drain never consumes a later system dictation's stash.
    pub fn take_visual_frame(expected: u64, id: &str) -> Result<serde_json::Value, String> {
        use base64::Engine;
        let deadline = Instant::now() + Duration::from_millis(1500);
        let (capture, strokes, raw_strokes) = loop {
            {
                let mut stash = lock_stash();
                if stash.generation != expected
                    || stash.visual_id.as_deref() != Some(id)
                    || !is_armed()
                {
                    return Err(
                        "The drawing owner changed. Capture this frame again in its original chat."
                            .into(),
                    );
                }
                if !stash.capturing && stash.strokes.is_some() {
                    break (
                        stash.capture.take(),
                        stash.strokes.take(),
                        stash.raw_strokes.take(),
                    );
                }
            }
            if Instant::now() >= deadline {
                return Err(
                    "The drawing surface did not confirm its marks. The frame was not added."
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        let capture =
            capture.ok_or("The original screen image is unavailable. Capture this frame again.")?;
        let strokes = strokes.unwrap_or_default();
        let (png, width, height) = if strokes.is_empty() {
            let image =
                image::load_from_memory(&capture.png_bytes).map_err(|error| error.to_string())?;
            (
                base64::engine::general_purpose::STANDARD.encode(&capture.png_bytes),
                image.width(),
                image.height(),
            )
        } else {
            let context = screen::composite_strokes(&capture, &strokes)
                .ok_or("Could not render the marks. The frame was not added.")?;
            (
                context.screen.png_base64,
                context.screen.img_w,
                context.screen.img_h,
            )
        };
        if png.len() + 22 > 5_000_000 {
            return Err("This screen image exceeds the chat image limit. Keep the draft and use a smaller image.".into());
        }
        Ok(
            serde_json::json!({ "dataUri": format!("data:image/png;base64,{png}"), "width": width, "height": height, "strokes": raw_strokes }),
        )
    }

    // ── JS → Rust event handlers ──

    fn on_first_stroke(app: &tauri::AppHandle, expected: Option<u64>) {
        let mut capture_generation = None;
        {
            let mut s = lock_stash();
            if is_armed()
                && expected.map_or(true, |generation| generation == s.generation)
                && !s.first_stroke_seen
            {
                s.first_stroke_seen = true;
                s.capturing = true;
                capture_generation = Some(s.generation);
            }
        }
        let Some(generation) = capture_generation else {
            return;
        };
        // Capture the marked monitor NOW (before ink renders), off the main
        // thread — the ~300-600ms screencapture subprocess overlaps the operator
        // still drawing + talking, so finalize pays no extra latency.
        let app2 = app.clone();
        use tauri::Manager;
        let monitor = app
            .get_webview_window(SPATIAL_INK_LABEL)
            .and_then(|window| window.current_monitor().ok().flatten());
        std::thread::spawn(move || {
            let cap = screen::capture_full(&app2, monitor);
            let mut s = lock_stash();
            if s.generation == generation {
                s.capture = cap;
                s.capturing = false;
            }
        });
    }

    fn stash_strokes(payload: StrokesPayload) {
        let mut s = lock_stash();
        if !is_armed() || s.visual_id != payload.visual_id {
            return;
        }
        let count: usize = payload
            .strokes
            .iter()
            .map(|stroke| stroke.points.len())
            .sum();
        if payload.strokes.len() > 128
            || count > 8192
            || payload.strokes.iter().any(|stroke| {
                stroke.points.iter().any(|point| {
                    !point.x.is_finite()
                        || !point.y.is_finite()
                        || !point.t.is_finite()
                        || !(0.0..=1.0).contains(&point.x)
                        || !(0.0..=1.0).contains(&point.y)
                        || !(0.0..=3_600_000.0).contains(&point.t)
                })
            })
        {
            return;
        }
        s.raw_strokes = serde_json::Value::Array(
            payload
                .strokes
                .iter()
                .map(|stroke| {
                    serde_json::json!({"points": stroke.points.iter().map(|point| {
                serde_json::json!({"x": point.x, "y": point.y, "tMs": point.t})
            }).collect::<Vec<_>>()})
                })
                .collect(),
        );
        s.strokes = Some(payload.into_points());
    }

    /// Register the JS → Rust event listeners once, after windows exist.
    pub fn register_listeners(app: &tauri::AppHandle) {
        use tauri::Listener;
        {
            let a = app.clone();
            app.listen("o8:spatial-ink-first-stroke", move |_event| {
                on_first_stroke(&a, None);
            });
        }
        {
            app.listen(
                "o8:spatial-ink-strokes",
                move |event| match serde_json::from_str::<StrokesPayload>(event.payload()) {
                    Ok(p) => stash_strokes(p),
                    Err(e) => log::warn!("[spatial-ink] bad strokes payload: {e}"),
                },
            );
        }
        {
            let a = app.clone();
            app.listen("o8:spatial-ink-disarm-request", move |_event| {
                disarm(&a);
            });
        }
        log::info!("[spatial-ink] event listeners registered");
    }

    // ── Drain at finalize ──

    /// Drain the stash and build the spatial images for the finishing agent turn.
    /// Returns None when the operator drew nothing (or the capture failed) — the
    /// turn then proceeds exactly as today, text-only, zero behavior change.
    pub fn take_spatial_context() -> Option<screen::SpatialContext> {
        // Wait briefly for an in-flight first-stroke capture AND for the strokes
        // event to land (both are fast vs finalize's own Whisper+polish latency).
        let deadline = Instant::now() + Duration::from_millis(1500);
        loop {
            let ready = {
                let s = lock_stash();
                if !s.first_stroke_seen {
                    // No stroke was ever drawn this session — nothing to do.
                    return None;
                }
                !s.capturing && s.strokes.is_some()
            };
            if ready || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(40));
        }

        let (capture, strokes) = {
            let mut s = lock_stash();
            let c = s.capture.take();
            let st = s.strokes.take();
            s.capturing = false;
            s.first_stroke_seen = false;
            (c, st)
        };

        let strokes = strokes?;
        if strokes.is_empty() {
            return None;
        }
        let capture = match capture {
            Some(c) => c,
            None => {
                log::warn!("[spatial-ink] strokes drawn but screen capture missing/failed");
                return None;
            }
        };
        screen::composite_strokes(&capture, &strokes)
    }

    #[cfg(test)]
    mod visual_tests {
        use super::*;
        use base64::Engine;
        #[test]
        fn visual_drain_fences_the_owner_and_preserves_marked_pixels() {
            let mut png = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                80,
                60,
                image::Rgba([255, 255, 255, 255]),
            ))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
            let old_stash = std::mem::replace(
                &mut *lock_stash(),
                Stash {
                    generation: 42,
                    visual_id: Some("frame-owned".into()),
                    capturing: false,
                    first_stroke_seen: true,
                    capture: Some(screen::RawCapture {
                        trace_id: 1,
                        png_bytes: png.into_inner(),
                        mon_x: 0.0,
                        mon_y: 0.0,
                        mon_w: 80.0,
                        mon_h: 60.0,
                        ax_catalog: Vec::new(),
                    }),
                    strokes: Some(vec![vec![(0.125, 0.5), (0.875, 0.5)]]),
                    raw_strokes: serde_json::json!([{ "points": [{"x":0.125,"y":0.5,"tMs":0},{"x":0.875,"y":0.5,"tMs":150}] }]),
                },
            );
            let old_armed = ARMED.swap(true, Ordering::SeqCst);
            assert!(take_visual_frame(41, "frame-owned").is_err());
            assert!(take_visual_frame(42, "another-frame").is_err());
            assert!(
                lock_stash().capture.is_some(),
                "a stale drain must not consume current pixels"
            );
            let value = take_visual_frame(42, "frame-owned").unwrap();
            let uri = value["dataUri"].as_str().unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(uri.split(',').nth(1).unwrap())
                .unwrap();
            let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
            assert_eq!((image.width(), image.height()), (80, 60));
            assert_eq!(image.get_pixel(40, 30).0, [0xFF, 0x5A, 0x1F, 0xFF]);
            assert_eq!(value["strokes"][0]["points"][1]["tMs"], 150);
            assert!(!uri.is_empty());
            *lock_stash() = old_stash;
            ARMED.store(old_armed, Ordering::SeqCst);
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::{
    arm, arm_visual, begin_visual_controls, capture_ready, create, disarm, disarm_visual,
    generation, is_armed, prime_capture, register_listeners, take_spatial_context,
    take_visual_frame,
};

// ── Non-macOS no-ops ──
#[cfg(not(target_os = "macos"))]
pub fn create(_app: &tauri::AppHandle, _api_port: u16) {}
#[cfg(not(target_os = "macos"))]
pub fn register_listeners(_app: &tauri::AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn arm(_app: &tauri::AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn disarm(_app: &tauri::AppHandle) {}
// No non-macOS take_spatial_context stub: its return type lives in the
// macOS-gated agent module and its only caller is macOS-gated too (#1673).
