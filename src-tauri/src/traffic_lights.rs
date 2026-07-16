//! macOS traffic-light positioning — o8 owns it at runtime.
//!
//! The static `trafficLightPosition` conf inset could only ever be right at
//! ONE UI zoom: the lights are native (fixed logical pt from the window top)
//! while the chrome centerline they must sit on is CSS — it scales with the
//! `--ui-zoom` CSS zoom. At 100% the conf value was ~5pt high of the sidebar
//! toggle; at 80/125% the delta grew (Q report, 0.1.604 screenshots). So the
//! conf inset is REMOVED and the frontend drives this instead: it invokes
//! `set_traffic_light_center` with the chrome centerline × current zoom, and
//! the window-event hook re-asserts after resizes (AppKit re-lays-out the
//! standard buttons on frame changes, exactly like tao's own draw_rect
//! re-assert did for the conf inset).
//!
//! Geometry mirrors tao's `inset_traffic_lights`: grow the title-bar
//! container downward from the window top so AppKit centers the buttons at
//! (button_height + inset_y) / 2 — we solve that for the requested CENTER,
//! so callers think in centerlines, not insets.

#![cfg(target_os = "macos")]

use std::sync::Mutex;

/// (x, center_y) in logical points from the window's top-left.
/// x = close button's left edge; center_y = the buttons' vertical centerline.
/// Default matches the chrome centerline at 100% zoom (strip pill center 20).
static REQUESTED: Mutex<(f64, f64)> = Mutex::new((14.0, 20.0));

/// Re-apply the last requested position. Main-thread only (window-event
/// handlers and `run_on_main_thread` closures qualify). Safe no-op when the
/// buttons are unavailable (fullscreen transition, window tearing down).
pub fn apply(win: &tauri::WebviewWindow) {
    use objc2::{msg_send, runtime::AnyObject};

    let (x, center_y) = *REQUESTED.lock().unwrap();
    if win.is_fullscreen().unwrap_or(false) {
        return;
    }
    let ns_window = match win.ns_window() {
        Ok(p) if !p.is_null() => p as *mut AnyObject,
        _ => return,
    };

    // CGRect/CGPoint by value with hand-rolled Encode impls so objc2's
    // msg_send! accepts them (the Cargo objc2-foundation feature set doesn't
    // pull the NSGeometry types).
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPointRaw {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSizeRaw {
        w: f64,
        h: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRectRaw {
        origin: CGPointRaw,
        size: CGSizeRaw,
    }
    unsafe impl objc2::Encode for CGPointRaw {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl objc2::Encode for CGSizeRaw {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl objc2::Encode for CGRectRaw {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGRect", &[CGPointRaw::ENCODING, CGSizeRaw::ENCODING]);
    }

    unsafe {
        // NSWindowButton: 0 = close, 1 = miniaturize, 2 = zoom.
        let close: *mut AnyObject = msg_send![ns_window, standardWindowButton: 0usize];
        let mini: *mut AnyObject = msg_send![ns_window, standardWindowButton: 1usize];
        let zoom: *mut AnyObject = msg_send![ns_window, standardWindowButton: 2usize];
        if close.is_null() || mini.is_null() || zoom.is_null() {
            return;
        }
        let superview: *mut AnyObject = msg_send![close, superview];
        if superview.is_null() {
            return;
        }
        let container: *mut AnyObject = msg_send![superview, superview];
        if container.is_null() {
            return;
        }

        let close_frame: CGRectRaw = msg_send![close, frame];
        let button_h = close_frame.size.h;
        // Container height = button_h + inset_y pins the buttons' center at
        // (button_h + inset_y) / 2 from the window top (tao semantics,
        // verified against live bitmaps 2026-07-15). Solve for center.
        let inset_y = (center_y * 2.0 - button_h).max(0.0);
        let title_bar_h = button_h + inset_y;

        let win_frame: CGRectRaw = msg_send![ns_window, frame];
        let mut container_frame: CGRectRaw = msg_send![container, frame];
        container_frame.size.h = title_bar_h;
        container_frame.origin.y = win_frame.size.h - title_bar_h;
        let _: () = msg_send![container, setFrame: container_frame];

        let mini_frame: CGRectRaw = msg_send![mini, frame];
        let spacing = mini_frame.origin.x - close_frame.origin.x;
        for (i, button) in [close, mini, zoom].into_iter().enumerate() {
            let frame: CGRectRaw = msg_send![button, frame];
            let origin = CGPointRaw {
                x: x + spacing * i as f64,
                y: frame.origin.y,
            };
            let _: () = msg_send![button, setFrameOrigin: origin];
        }
    }
}

/// Frontend entry point: place the traffic lights' CENTER at `center_y`
/// logical pt below the window top (close button left edge at `x`). The UI
/// zoom layer calls this with chrome-centerline × zoom on boot and on every
/// zoom change, so the lights stay glued to the sidebar toggle at any zoom.
#[tauri::command]
pub fn set_traffic_light_center(window: tauri::WebviewWindow, x: f64, center_y: f64) {
    // Sanity clamps — a bad invoke must never fling the buttons off-window.
    let x = x.clamp(0.0, 200.0);
    let center_y = center_y.clamp(4.0, 200.0);
    *REQUESTED.lock().unwrap() = (x, center_y);
    let win = window.clone();
    let _ = window.run_on_main_thread(move || apply(&win));
}
