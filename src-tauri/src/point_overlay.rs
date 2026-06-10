//! Symon Points — the screen pointing overlay (Clicky-parity dossier #1).
//!
//! A THIRD always-on-top transparent Tauri window — label **`point-overlay`**,
//! never `main`, never `dock`. Unlike the dock it is fully CLICK-THROUGH
//! (`set_ignore_cursor_events(true)`): it exists only to paint the animated
//! glass-dot pointer + label chips over the user's screen while Symon answers
//! "where is it?" questions, and must never eat a click.
//!
//! Protocol: the agent model emits `[POINT:x,y:label]` tags inline in its
//! reply text (LLM-native, no tool-call overhead — x,y in SCREENSHOT pixels).
//! `parse_point_tags` strips them from the spoken/displayed text;
//! `show_points` maps screenshot px → monitor-local logical points using the
//! `ScreenContext` geometry recorded at capture time, then positions this
//! window over the captured monitor and emits `o8:point-show` to the
//! `/point-overlay` route. The same three-axis transform class that bit the
//! webview MCP tools (#1105) — screenshot px vs display points vs Retina
//! scale — is centralized HERE, in one function, on purpose.
//!
//! Lifecycle: lazy-created on first use, then kept alive hidden (first paint
//! costs a Next route load; reuse is instant). A generation counter guards the
//! auto-hide timer so a newer show is never clobbered by an older timer.

#[cfg(target_os = "macos")]
pub const POINT_LABEL: &str = "point-overlay";

/// One parsed `[POINT:...]` / `[GUIDE:...]` tag, still in screenshot-pixel space.
pub struct ParsedTag {
    pub x: f64,
    pub y: f64,
    pub label: String,
    /// GUIDE tags (magic roadmap #3): the marker lands and DWELLS pulsing
    /// until the user's cursor reaches it (or a long cap) instead of the
    /// 8s auto-fade — the un-lost button.
    pub dwell: bool,
}

/// Parse and STRIP `[POINT:x,y:label]` and `[GUIDE:x,y:label]` tags (optionally
/// `...:screenN` — the screen suffix is accepted and ignored in v1,
/// single-monitor capture). Returns the cleaned text (what gets spoken/stored)
/// plus the tags in order. Malformed tags are stripped but skipped — garbage
/// never reaches TTS.
pub fn parse_point_tags(text: &str) -> (String, Vec<ParsedTag>) {
    const PREFIXES: [(&str, bool); 2] = [("[POINT:", false), ("[GUIDE:", true)];
    let mut clean = String::with_capacity(text.len());
    let mut tags: Vec<ParsedTag> = Vec::new();
    let mut rest = text;

    loop {
        // Earliest occurrence of either prefix wins.
        let found = PREFIXES
            .iter()
            .filter_map(|(p, dwell)| rest.find(p).map(|i| (i, *p, *dwell)))
            .min_by_key(|(i, _, _)| *i);
        let Some((start, prefix, dwell)) = found else {
            break;
        };
        let (before, tail) = rest.split_at(start);
        clean.push_str(before);
        let Some(end) = tail.find(']') else {
            // Unterminated tag — keep the text as-is and stop scanning.
            clean.push_str(tail);
            rest = "";
            break;
        };
        let inner = &tail[prefix.len()..end];
        if let Some(mut tag) = parse_tag_inner(inner) {
            tag.dwell = dwell;
            tags.push(tag);
        }
        rest = &tail[end + 1..];
    }
    clean.push_str(rest);

    // Tag removal can leave doubled spaces / dangling space-before-punct.
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    (clean, tags)
}

/// `x,y:label` or `x,y:label:screenN` → ParsedTag. Labels may contain ':'
/// (everything between the coords and a trailing screenN is the label).
fn parse_tag_inner(inner: &str) -> Option<ParsedTag> {
    let mut segments: Vec<&str> = inner.split(':').collect();
    if segments.len() < 2 {
        return None;
    }
    // Drop a trailing `screenN` qualifier if present.
    if segments.len() > 2 {
        if let Some(last) = segments.last() {
            let l = last.trim().to_ascii_lowercase();
            if l.strip_prefix("screen").is_some_and(|n| n.parse::<usize>().is_ok()) {
                segments.pop();
            }
        }
    }
    let coords = segments.remove(0);
    let label = segments.join(":").trim().to_string();
    let (x_str, y_str) = coords.split_once(',')?;
    let x = x_str.trim().parse::<f64>().ok()?;
    let y = y_str.trim().parse::<f64>().ok()?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some(ParsedTag { x, y, label, dwell: false })
}

#[cfg(test)]
mod parse_tests {
    use super::*;

    #[test]
    fn strips_single_tag_and_parses() {
        let (clean, tags) =
            parse_point_tags("It's right here. [POINT:640,360:Save button] Click it.");
        assert_eq!(clean, "It's right here. Click it.");
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].x, 640.0);
        assert_eq!(tags[0].label, "Save button");
    }

    #[test]
    fn accepts_screen_suffix_and_colon_labels() {
        let (clean, tags) = parse_point_tags("[POINT:10,20:Step 1: open settings:screen2] go");
        assert_eq!(clean, "go");
        assert_eq!(tags[0].label, "Step 1: open settings");
        assert_eq!(tags[0].y, 20.0);
    }

    #[test]
    fn multiple_tags_in_order() {
        let (clean, tags) = parse_point_tags("First [POINT:1,2:a] then [POINT:3,4:b] done");
        assert_eq!(clean, "First then done");
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[1].x, 3.0);
    }

    #[test]
    fn malformed_tags_stripped_not_kept() {
        let (clean, tags) = parse_point_tags("Hm [POINT:abc,def:bad] ok");
        assert_eq!(clean, "Hm ok");
        assert!(tags.is_empty());
    }

    #[test]
    fn no_tags_passthrough() {
        let (clean, tags) = parse_point_tags("Nothing to point at.");
        assert_eq!(clean, "Nothing to point at.");
        assert!(tags.is_empty());
    }

    #[test]
    fn guide_tag_sets_dwell() {
        let (clean, tags) = parse_point_tags("Right here. [GUIDE:320,200:Reply button]");
        assert_eq!(clean, "Right here.");
        assert_eq!(tags.len(), 1);
        assert!(tags[0].dwell);
        assert_eq!(tags[0].label, "Reply button");
    }

    #[test]
    fn mixed_point_and_guide_in_order() {
        let (clean, tags) = parse_point_tags("A [POINT:1,2:a] then [GUIDE:3,4:b] done");
        assert_eq!(clean, "A then done");
        assert_eq!(tags.len(), 2);
        assert!(!tags[0].dwell);
        assert!(tags[1].dwell);
        assert_eq!(tags[1].x, 3.0);
    }
}

// ── macOS implementation ─────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod overlay {
    use super::ParsedTag;
    use crate::agent::screen::ScreenContext;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::OnceLock;
    use tauri::{Emitter, Manager};

    /// Resolved frontend port, stashed at setup so the lazily-created overlay
    /// window can build its URL (mirrors how dock_window gets `api_port`).
    static API_PORT: OnceLock<u16> = OnceLock::new();

    /// Show-generation guard: each `show_points` bumps this; the auto-hide
    /// timer only fires if its generation is still current.
    static GENERATION: AtomicU64 = AtomicU64::new(0);

    pub fn init(api_port: u16) {
        let _ = API_PORT.set(api_port);
    }

    /// Map screenshot-pixel tags onto the captured monitor and animate them.
    /// Fire-and-forget: spawns a worker thread that ensures the window (first
    /// use pays a route-load wait), emits `o8:point-show`, then auto-hides.
    pub fn show_points(app: &tauri::AppHandle, screen: &ScreenContext, tags: &[ParsedTag]) {
        if tags.is_empty() {
            return;
        }
        // Screenshot px → window-local logical points. The overlay window is
        // positioned at the monitor origin with the monitor's logical size, so
        // local = (tag / image_px) * monitor_logical, clamped into bounds.
        let points: Vec<serde_json::Value> = tags
            .iter()
            .map(|t| {
                let x = (t.x / screen.img_w as f64 * screen.mon_w).clamp(0.0, screen.mon_w);
                let y = (t.y / screen.img_h as f64 * screen.mon_h).clamp(0.0, screen.mon_h);
                json!({ "x": x, "y": y, "label": t.label, "dwell": t.dwell })
            })
            .collect();
        // GUIDE targets in window-local logical px — the proximity watcher
        // compares the live cursor against these instead of a fixed timer.
        let dwell_targets: Vec<(f64, f64)> = points
            .iter()
            .filter(|p| p["dwell"].as_bool() == Some(true))
            .map(|p| (p["x"].as_f64().unwrap_or(0.0), p["y"].as_f64().unwrap_or(0.0)))
            .collect();

        let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let count = points.len();
        // Singles linger 8s; tours earn 2.5s per extra marker, capped at 20s.
        // A GUIDE dwells much longer — it waits for the user, capped at 90s.
        let duration_ms: u64 = if dwell_targets.is_empty() {
            (8_000 + 2_500 * (count as u64 - 1)).min(20_000)
        } else {
            90_000
        };
        let payload = json!({
            "gen": gen,
            "points": points,
            "tour": tags.len() > 1,
            "durationMs": duration_ms,
        });

        let app = app.clone();
        let (mon_x, mon_y, mon_w, mon_h) = (screen.mon_x, screen.mon_y, screen.mon_w, screen.mon_h);
        std::thread::spawn(move || {
            let fresh = ensure_window(&app);
            if app.get_webview_window(super::POINT_LABEL).is_none() {
                return;
            }
            if fresh {
                // First creation: let the /point-overlay route hydrate before
                // the show event, or the listener misses it.
                std::thread::sleep(std::time::Duration::from_millis(1_400));
            }
            place_and_show(&app, mon_x, mon_y, mon_w, mon_h);
            let _ = app.emit_to(super::POINT_LABEL, "o8:point-show", payload);
            log::info!("[point-overlay] gen {gen}: showing {count} point(s) for {duration_ms}ms (dwell: {})", !dwell_targets.is_empty());

            if dwell_targets.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(duration_ms));
            } else {
                dwell_until_reached(&app, gen, duration_ms, &dwell_targets);
            }
            if GENERATION.load(Ordering::SeqCst) == gen {
                hide_with_fade(&app);
            }
        });
    }

    /// GUIDE lifecycle: poll the cursor (~150ms, the dock poller's cadence
    /// class) until it reaches a dwell target — "the user acted" — then grant
    /// a short grace so the ring is still there as they click, and return.
    /// Also returns at the cap, or immediately when a newer show supersedes
    /// this generation. Same physical-px coordinate math as
    /// `dock_window::cursor_probe` — cursor, window origin, and scale all from
    /// the same window so mixed-DPI monitors stay consistent.
    fn dwell_until_reached(app: &tauri::AppHandle, gen: u64, cap_ms: u64, targets: &[(f64, f64)]) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(cap_ms);
        let mut grace_until: Option<std::time::Instant> = None;
        loop {
            if GENERATION.load(Ordering::SeqCst) != gen {
                return; // superseded — the newer show owns the window now
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return;
            }
            if let Some(g) = grace_until {
                if now >= g {
                    return;
                }
            } else if cursor_near(app, targets) {
                grace_until = Some(now + std::time::Duration::from_millis(2_500));
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }

    /// Is the live cursor within ~56 logical px of any target? Targets are
    /// window-local logical; cursor + window origin are physical.
    fn cursor_near(app: &tauri::AppHandle, targets: &[(f64, f64)]) -> bool {
        let Some(window) = app.get_webview_window(super::POINT_LABEL) else {
            return false;
        };
        let Ok(cursor) = app.cursor_position() else {
            return false;
        };
        let Ok(pos) = window.outer_position() else {
            return false;
        };
        let Ok(scale) = window.scale_factor() else {
            return false;
        };
        let radius = 56.0 * scale;
        targets.iter().any(|(lx, ly)| {
            let tx = pos.x as f64 + lx * scale;
            let ty = pos.y as f64 + ly * scale;
            let dx = cursor.x - tx;
            let dy = cursor.y - ty;
            dx * dx + dy * dy <= radius * radius
        })
    }

    /// Immediately retire any visible pointers (called when a new agent task
    /// starts — stale pointers over a changed screen are worse than none).
    pub fn hide_now(app: &tauri::AppHandle) {
        GENERATION.fetch_add(1, Ordering::SeqCst);
        if app.get_webview_window(super::POINT_LABEL).is_some() {
            hide_with_fade(app);
        }
    }

    /// Emit the fade event, give the CSS fade its 500ms, then hide the window.
    fn hide_with_fade(app: &tauri::AppHandle) {
        let _ = app.emit_to(super::POINT_LABEL, "o8:point-hide", json!({}));
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            if let Some(w) = app.get_webview_window(super::POINT_LABEL) {
                let _ = w.hide();
            }
        });
    }

    /// Create the overlay window if missing (on the MAIN thread — NSWindow
    /// construction is main-thread-only; we block on an mpsc ack). Returns
    /// true when the window was freshly created this call.
    fn ensure_window(app: &tauri::AppHandle) -> bool {
        if app.get_webview_window(super::POINT_LABEL).is_some() {
            return false;
        }
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = tx.send(build_window(&app2));
        });
        rx.recv_timeout(std::time::Duration::from_secs(4)).unwrap_or(false)
    }

    /// Build the transparent click-through window over the bundled `/point-overlay`
    /// route. Same recipe as the dock (clearColor, level 25, nonactivating,
    /// all-spaces) PLUS ignore-cursor-events — this surface never takes input.
    fn build_window(app: &tauri::AppHandle) -> bool {
        use tauri::{WebviewUrl, WebviewWindowBuilder};

        let base = match crate::dev_frontend::from_env() {
            Ok(Some(dev)) => dev.origin().to_string(),
            _ => format!("http://127.0.0.1:{}", API_PORT.get().copied().unwrap_or(3001)),
        };
        let url = format!("{base}/point-overlay");
        let parsed = match url.parse() {
            Ok(u) => u,
            Err(e) => {
                log::warn!("[point-overlay] bad url {url}: {e}");
                return false;
            }
        };

        let window = WebviewWindowBuilder::new(app, super::POINT_LABEL, WebviewUrl::External(parsed))
            .title("o8 pointer")
            .inner_size(800.0, 600.0) // placeholder — sized to the monitor at show
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .shadow(false)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .disable_drag_drop_handler()
            .build();

        let window = match window {
            Ok(w) => w,
            Err(e) => {
                log::warn!("[point-overlay] failed to build overlay window: {e}");
                return false;
            }
        };

        apply_macos_recipe(&window);
        // CLICK-THROUGH: the whole point (vs the dock, which takes clicks).
        let _ = window.set_ignore_cursor_events(true);
        log::info!("[point-overlay] overlay window created → {url}");
        true
    }

    /// Cover the captured monitor exactly, then order front without activating.
    fn place_and_show(app: &tauri::AppHandle, x: f64, y: f64, w: f64, h: f64) {
        let Some(window) = app.get_webview_window(super::POINT_LABEL) else {
            return;
        };
        let _ = window.set_size(tauri::LogicalSize::new(w, h));
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        let _ = window.set_ignore_cursor_events(true);
        order_front_nonactivating(&window);
    }

    /// Transparent + level-25 + nonactivating NSWindow recipe (mirrors
    /// dock_window::apply_macos_recipe — kept separate so the two windows'
    /// postures can diverge without coupling).
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
            // Safety: Tauri guarantees a live NSWindow for the window's
            // lifetime; this closure runs on the main thread.
            unsafe {
                let ns_window = &*ptr;
                let clear = NSColor::clearColor();
                ns_window.setBackgroundColor(Some(&clear));
                ns_window.setOpaque(false);
                ns_window.setLevel(25);
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

    /// Show without making key (orderFrontRegardless) — same rationale as the
    /// dock: the app the user is looking at must keep focus.
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
}

#[cfg(target_os = "macos")]
pub use overlay::{hide_now, init, show_points};

// ── Non-macOS no-ops ──
#[cfg(not(target_os = "macos"))]
pub fn init(_api_port: u16) {}
#[cfg(not(target_os = "macos"))]
pub fn hide_now(_app: &tauri::AppHandle) {}
