//! Screen-level dock pill window (system-wide Symon fold P3).
//!
//! A SECOND always-on-top, transparent Tauri window — label **`dock`**, NEVER
//! `main`. Label discipline is load-bearing: the dev-mcp plugin's
//! `.default_webview_label('main')`, the updater's main-window page-load hook,
//! `apply_vibrancy(HudWindow)`, the DragDrop bridge, and the console-error hook
//! all key off `main` and must stay blind to this window.
//!
//! It loads the bundled-Next route `/dictation-pill` (mirrors main → /dashboard)
//! and shows the morphing Symon pill at the TOP of the screen during global-Fn
//! (system) dictation, so the user sees it without o8 focused. The in-window
//! pill (DictationHost) is untouched and only shows on the mic-button path.
//!
//! macOS recipe (ported from aqua/Symon `set_macos_window_level` +
//! `resize_and_reposition_pill_window`):
//!   - NSWindow backgroundColor = clearColor + setOpaque(false): the window is
//!     transparent so only the pill paints (NOT HudWindow vibrancy — that dark
//!     material would gray out the light pill).
//!   - setLevel(25): one above the menu bar (level 24) so it hangs over the
//!     true top of the screen.
//!   - top-center anchor: x centered, y = screen origin_y + small offset.
//!   - NONACTIVATING: the window must never become key / steal focus from the
//!     app the user is dictating into. Tauri windows are plain NSWindows (not
//!     NSPanels) so `canBecomeKey` can't be overridden without subclassing; the
//!     reliable combination is window-config `focus:false` + showing via
//!     `orderFrontRegardless` (orders front WITHOUT activating) +
//!     `setHidesOnDeactivate(false)` + a Stationary/CanJoinAllSpaces collection
//!     behavior so it sits across spaces without grabbing key state.

#[cfg(target_os = "macos")]
pub const DOCK_LABEL: &str = "dock";

/// Logical size of the dock window. The pill content centers inside this; the
/// React layer keeps the dead-zone tight (pointer-events: none on the wrapper).
#[cfg(target_os = "macos")]
const DOCK_WIDTH: f64 = 520.0;
#[cfg(target_os = "macos")]
const DOCK_HEIGHT: f64 = 120.0;
/// Small top inset below the true screen origin so the pill doesn't kiss the
/// physical top edge / notch.
#[cfg(target_os = "macos")]
const DOCK_TOP_INSET: f64 = 6.0;

/// Create the dock window and navigate it to `/dictation-pill` on the bundled
/// Next server, then apply the macOS transparency + level + anchor recipe.
/// Idempotent: a second call is a no-op if the window already exists.
///
/// Call this from `setup()` AFTER the bundled Next server is confirmed up
/// (mirrors the main → /dashboard loader pattern). `api_port` is the resolved
/// Next port written to ~/.o8/api-port.
#[cfg(target_os = "macos")]
pub fn create(app: &tauri::AppHandle, api_port: u16) {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    if app.get_webview_window(DOCK_LABEL).is_some() {
        return;
    }

    let url = format!("http://127.0.0.1:{}/dictation-pill", api_port);
    let parsed = match url.parse() {
        Ok(u) => u,
        Err(e) => {
            log::warn!("[dock-window] bad url {url}: {e}");
            return;
        }
    };

    let window = WebviewWindowBuilder::new(app, DOCK_LABEL, WebviewUrl::External(parsed))
        .title("o8 dictation")
        .inner_size(DOCK_WIDTH, DOCK_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .shadow(false)
        .skip_taskbar(true)
        // Nonactivating: do NOT make the window key/focused when it appears.
        .focused(false)
        .visible(false)
        // OS-level drag-drop bridge is main-only; the dock takes no drops.
        // dragDropEnabled:false on this window.
        .disable_drag_drop_handler()
        .build();

    let window = match window {
        Ok(w) => w,
        Err(e) => {
            log::warn!("[dock-window] failed to build dock window: {e}");
            return;
        }
    };

    apply_macos_recipe(&window);
    reposition(&window);
    // Keep the cursor dead-zone tight in the React layer, not by globally
    // ignoring cursor events on the Rust side (matches Symon's pill).
    let _ = window.set_ignore_cursor_events(false);
    log::info!("[dock-window] dock pill window created → {url}");
}

/// Show the dock pill for a SYSTEM (global-Fn) dictation. Re-anchors first (the
/// active monitor may have changed since last show), then orders it front
/// WITHOUT making it key — the app the user is dictating into keeps focus.
#[cfg(target_os = "macos")]
pub fn show(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(DOCK_LABEL) else {
        return;
    };
    reposition(&window);
    apply_macos_recipe(&window);
    order_front_nonactivating(&window);
}

/// Hide the dock pill after the system paste lands (the React layer flashes
/// "Pasted" first; Rust hides on a short delay). No-op if missing.
#[cfg(target_os = "macos")]
pub fn hide(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window(DOCK_LABEL) {
        let _ = window.hide();
    }
}

/// Apply the transparent + level-25 + nonactivating NSWindow recipe. Runs on
/// the main thread (NSWindow mutations are main-thread-only). Idempotent.
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
            // Transparent: only the pill paints, no opaque rectangle. Do NOT
            // apply HudWindow vibrancy here — dark material grays the light pill.
            let clear = NSColor::clearColor();
            ns_window.setBackgroundColor(Some(&clear));
            ns_window.setOpaque(false);
            // Level 25 = one above the menu bar (24): hangs over the top of the
            // screen. NSWindowLevel is NSInteger.
            ns_window.setLevel(25);
            // Nonactivating posture: never grab key focus on show, never hide
            // when the owning app deactivates, and sit across spaces as a
            // stationary auxiliary window.
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
/// `WebviewWindow::show()` can route through a key/activate path on some Tauri
/// versions; `orderFrontRegardless` is the AppKit-level "show but don't steal
/// focus" call. We still call `show()` first so Tauri's visibility bookkeeping
/// stays consistent, then immediately order-front-regardless on the main thread.
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

/// Top-center anchor the dock window on the active monitor (falls back to the
/// primary). Logical coordinates, mirroring aqua's `resize_and_reposition`
/// notch branch: x centered, y = monitor origin_y + a small inset.
#[cfg(target_os = "macos")]
fn reposition(window: &tauri::WebviewWindow) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let origin_x = monitor.position().x as f64 / scale;
    let origin_y = monitor.position().y as f64 / scale;
    let logical_w = monitor.size().width as f64 / scale;
    let x = origin_x + (logical_w - DOCK_WIDTH) / 2.0;
    let y = origin_y + DOCK_TOP_INSET;
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

// ── Non-macOS no-ops ──
#[cfg(not(target_os = "macos"))]
pub fn create(_app: &tauri::AppHandle, _api_port: u16) {}
#[cfg(not(target_os = "macos"))]
pub fn show(_app: &tauri::AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn hide(_app: &tauri::AppHandle) {}
