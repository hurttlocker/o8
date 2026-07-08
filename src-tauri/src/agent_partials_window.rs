//! Screen-level AGENT PARTIALS window (outside-the-window live transcription).
//!
//! A THIRD always-on-top, transparent, fully click-through Tauri window — label
//! **`agent-partials`**, NEVER `main` (same label-discipline invariant as
//! `dock_window`: the dev-mcp plugin's `.default_webview_label('main')`, the
//! updater's main-window page-load hook, `apply_vibrancy(HudWindow)`, the
//! DragDrop bridge, and the console-error hook all key off `main` and must stay
//! blind to this window).
//!
//! It loads the bundled-Next route `/agent-partials` and shows the big black
//! live-transcription "partials" bar at the BOTTOM-CENTER of the screen while
//! the operator holds Right-Option to talk to the Symon voice AGENT — so the
//! partials are visible even when o8 is not the frontmost app. This is the
//! outside-the-window twin of the in-canvas black partials bar
//! (`symon-voice-presence.tsx`), which is suppressed for the listening phase now
//! that this surface owns it.
//!
//! Recipe (a simplified port of `dock_window`):
//!   - NSWindow backgroundColor = clearColor + setOpaque(false): the window is
//!     transparent so only the bar paints. NOT HudWindow vibrancy.
//!   - setLevel(25): one above the menu bar so it floats over everything.
//!   - bottom-center anchor on the monitor the MAIN o8 window sits on (falls
//!     back to primary), `BOTTOM_MARGIN` above the screen edge to clear the Dock.
//!   - NONACTIVATING: never key / never steals focus (window-config
//!     `focus:false` + `orderFrontRegardless` + `setHidesOnDeactivate(false)` +
//!     a CanJoinAllSpaces / Stationary collection behavior).
//!   - FULLY CLICK-THROUGH: unlike the dock (which flips click-through per the
//!     pill hit-rect so its buttons stay tappable), this HUD has NO interactive
//!     elements, so `set_ignore_cursor_events(true)` on the whole window — no
//!     hit-test poller needed. Every click passes through to whatever is behind.
//!
//! The window is ALWAYS-ON: created visible at boot and never hidden. The PAGE
//! controls visibility by rendering NOTHING (transparent = invisible) unless an
//! agent-lane dictation is live, so there is no show/hide churn here.

#[cfg(target_os = "macos")]
pub const PARTIALS_LABEL: &str = "agent-partials";

/// Logical size of the partials window. Generous so the centered bar can grow
/// to ~3 lines and the enter/exit rise animation never clips; the extra area is
/// transparent + click-through, so a larger frame is invisible and harmless.
#[cfg(target_os = "macos")]
const PARTIALS_WIDTH: f64 = 820.0;
#[cfg(target_os = "macos")]
const PARTIALS_HEIGHT: f64 = 220.0;
/// Bottom inset above the screen edge — clears the macOS Dock in most setups.
#[cfg(target_os = "macos")]
const BOTTOM_MARGIN: f64 = 48.0;

/// Create the partials window and navigate it to `/agent-partials` on the
/// bundled Next server, then apply the macOS transparency + level + anchor
/// recipe. Idempotent: a second call is a no-op if the window already exists.
///
/// Call this from `setup()` AFTER the bundled Next server is confirmed up
/// (mirrors the dock window). `api_port` is the resolved Next port.
#[cfg(target_os = "macos")]
pub fn create(app: &tauri::AppHandle, api_port: u16) {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    if app.get_webview_window(PARTIALS_LABEL).is_some() {
        return;
    }

    // In dev-bridge mode (O8_DEV_FRONTEND_URL set), load from the dev Next
    // server so UI edits show without a full ship — same reasoning as the dock.
    let base = match crate::dev_frontend::from_env() {
        Ok(Some(dev)) => {
            log::info!(
                "[agent-partials] dev-bridge: loading from {}",
                dev.origin()
            );
            dev.origin().to_string()
        }
        _ => format!("http://127.0.0.1:{}", api_port),
    };
    let url = format!("{}/agent-partials", base);
    let parsed = match url.parse() {
        Ok(u) => u,
        Err(e) => {
            log::warn!("[agent-partials] bad url {url}: {e}");
            return;
        }
    };

    let window = WebviewWindowBuilder::new(app, PARTIALS_LABEL, WebviewUrl::External(parsed))
        .title("o8 agent partials")
        .inner_size(PARTIALS_WIDTH, PARTIALS_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .shadow(false)
        .skip_taskbar(true)
        // Nonactivating: never become key / steal focus from the app the user is
        // dictating into.
        .focused(false)
        // ALWAYS-ON: created visible; the page paints nothing until an agent
        // dictation is live, so the window is invisible at rest.
        .visible(true)
        // OS-level drag-drop bridge is main-only; this HUD takes no drops.
        .disable_drag_drop_handler()
        .build();

    let window = match window {
        Ok(w) => w,
        Err(e) => {
            log::warn!("[agent-partials] failed to build window: {e}");
            return;
        }
    };

    apply_macos_recipe(&window);
    reposition(app, &window);
    // FULLY click-through — no interactive elements on this surface, so every
    // click passes through to the app behind it. No per-element hit-testing.
    let _ = window.set_ignore_cursor_events(true);
    order_front_nonactivating(&window);
    log::info!("[agent-partials] partials window created (always-on) → {url}");
}

/// Re-assert the always-on partials window: re-anchor (the MAIN window may have
/// moved to another monitor since boot), re-apply the recipe, re-assert the
/// full click-through, and re-order front WITHOUT making it key. Safe to call on
/// agent-dictation start (belt-and-suspenders, and it makes the bar follow the
/// main window's current monitor). No-op if the window is missing.
#[cfg(target_os = "macos")]
pub fn show(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(PARTIALS_LABEL) else {
        return;
    };
    reposition(app, &window);
    apply_macos_recipe(&window);
    let _ = window.set_ignore_cursor_events(true);
    order_front_nonactivating(&window);
}

/// Apply the transparent + level-25 + nonactivating NSWindow recipe. Runs on the
/// main thread (NSWindow mutations are main-thread-only). Idempotent.
#[cfg(target_os = "macos")]
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
            // Transparent: only the bar paints, no opaque rectangle. Do NOT
            // apply HudWindow vibrancy — dark material would tint the HUD.
            let clear = NSColor::clearColor();
            ns_window.setBackgroundColor(Some(&clear));
            ns_window.setOpaque(false);
            // Level 25 = one above the menu bar: floats over everything.
            ns_window.setLevel(25);
            // Nonactivating posture: never grab key focus on show, never hide
            // when the owning app deactivates, sit across spaces as a stationary
            // auxiliary window.
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

/// Order the window front WITHOUT activating the app or making the window key.
/// Mirrors `dock_window::order_front_nonactivating`.
#[cfg(target_os = "macos")]
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

/// Bottom-center anchor on the monitor the MAIN o8 window sits on (falls back to
/// this window's current monitor, then the primary). Logical coordinates. Runs
/// on the main thread (NSScreen reads touch AppKit).
#[cfg(target_os = "macos")]
fn reposition(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    use tauri::Manager;
    let win = window.clone();
    let app = app.clone();
    let _ = window.run_on_main_thread(move || {
        // Prefer the monitor the MAIN window is on so the bar shows on the screen
        // the operator is actually working on; degrade to this window's monitor,
        // then the primary.
        let monitor = app
            .get_webview_window("main")
            .and_then(|m| m.current_monitor().ok().flatten())
            .or_else(|| win.current_monitor().ok().flatten())
            .or_else(|| win.primary_monitor().ok().flatten());
        let Some(monitor) = monitor else {
            return;
        };
        let scale = monitor.scale_factor();
        let origin_x = monitor.position().x as f64 / scale;
        let origin_y = monitor.position().y as f64 / scale;
        let logical_w = monitor.size().width as f64 / scale;
        let logical_h = monitor.size().height as f64 / scale;
        let x = origin_x + (logical_w - PARTIALS_WIDTH) / 2.0;
        let y = origin_y + logical_h - PARTIALS_HEIGHT - BOTTOM_MARGIN;
        let _ = win.set_position(tauri::LogicalPosition::new(x, y));
    });
}

// ── Non-macOS no-ops ──
#[cfg(not(target_os = "macos"))]
pub fn create(_app: &tauri::AppHandle, _api_port: u16) {}
#[cfg(not(target_os = "macos"))]
pub fn show(_app: &tauri::AppHandle) {}
