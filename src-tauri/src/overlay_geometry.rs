//! Shared logical-point geometry for Symon's screen-level overlay windows.
//!
//! macOS window frames are expressed in AppKit points. Keep the requested
//! overlay size in that unit all the way to `NSWindow`; routing a point size
//! through a scale-aware physical/logical conversion makes repeated mixed-DPI
//! monitor events capable of multiplying the frame.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LogicalScreen {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
    pub is_primary: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LogicalWindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn fixed_logical_size(width: f64, height: f64) -> Option<(f64, f64)> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return None;
    }
    Some((width, height))
}

/// Return a fixed-size top-center frame on the primary monitor.
///
/// Inputs and outputs are desktop logical points with a top-left origin. The
/// result depends only on the requested size and primary screen, never on the
/// overlay's current frame or backing scale, so applying it repeatedly is
/// idempotent.
pub fn primary_top_center(
    screens: &[LogicalScreen],
    width: f64,
    height: f64,
    top_inset: f64,
) -> Option<LogicalWindowFrame> {
    let primary = screens.iter().find(|screen| screen.is_primary)?;
    let (width, height) = fixed_logical_size(width, height)?;
    if !primary.width.is_finite() {
        return None;
    }
    Some(LogicalWindowFrame {
        x: primary.x + (primary.width - width) / 2.0,
        y: primary.y + top_inset,
        width,
        height,
    })
}

#[cfg(target_os = "macos")]
pub fn set_content_size_points(window: &tauri::WebviewWindow, width: f64, height: f64) -> bool {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::NSSize;

    let Some((width, height)) = fixed_logical_size(width, height) else {
        return false;
    };
    let Ok(ptr) = window.ns_window() else {
        return false;
    };
    let ptr = ptr as *mut NSWindow;
    if ptr.is_null() {
        return false;
    }
    // Safety: callers run on the main thread and Tauri guarantees a live
    // NSWindow for the webview window's lifetime.
    unsafe {
        (*ptr).setContentSize(NSSize::new(width, height));
    }
    true
}

#[cfg(target_os = "macos")]
pub fn set_frame_points(
    window: &tauri::WebviewWindow,
    frame: LogicalWindowFrame,
    primary_appkit_top: f64,
) -> bool {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::{NSPoint, NSSize};

    let Ok(ptr) = window.ns_window() else {
        return false;
    };
    let ptr = ptr as *mut NSWindow;
    if ptr.is_null() {
        return false;
    }
    // Safety: callers run on the main thread and Tauri guarantees a live
    // NSWindow for the webview window's lifetime.
    unsafe {
        let ns_window = &*ptr;
        ns_window.setContentSize(NSSize::new(frame.width, frame.height));
        ns_window.setFrameTopLeftPoint(NSPoint::new(frame.x, primary_appkit_top - frame.y));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::{fixed_logical_size, primary_top_center, LogicalScreen, LogicalWindowFrame};

    const DOCK_WIDTH: f64 = 520.0;
    const DOCK_HEIGHT: f64 = 120.0;

    fn primary() -> LogicalScreen {
        LogicalScreen {
            x: 0.0,
            y: 0.0,
            width: 2560.0,
            height: 1440.0,
            scale_factor: 2.0,
            is_primary: true,
        }
    }

    #[test]
    fn top_centers_on_primary_in_exact_mixed_dpi_fixture() {
        let screens = [
            primary(),
            LogicalScreen {
                x: 2560.0,
                y: 0.0,
                width: 2560.0,
                height: 1440.0,
                scale_factor: 1.0,
                is_primary: false,
            },
        ];

        assert_eq!(
            primary_top_center(&screens, DOCK_WIDTH, DOCK_HEIGHT, 0.0),
            Some(LogicalWindowFrame {
                x: 1020.0,
                y: 0.0,
                width: 520.0,
                height: 120.0,
            })
        );
    }

    #[test]
    fn left_hand_secondary_does_not_move_primary_anchor() {
        let screens = [
            LogicalScreen {
                x: -2560.0,
                y: 0.0,
                width: 2560.0,
                height: 1440.0,
                scale_factor: 1.0,
                is_primary: false,
            },
            primary(),
        ];

        assert_eq!(
            primary_top_center(&screens, DOCK_WIDTH, DOCK_HEIGHT, 0.0),
            Some(LogicalWindowFrame {
                x: 1020.0,
                y: 0.0,
                width: 520.0,
                height: 120.0,
            })
        );
    }

    #[test]
    fn repeated_monitor_events_cannot_compound_requested_size() {
        let screens = [
            primary(),
            LogicalScreen {
                x: 2560.0,
                y: 0.0,
                width: 2560.0,
                height: 1440.0,
                scale_factor: 1.0,
                is_primary: false,
            },
        ];
        let expected = primary_top_center(&screens, DOCK_WIDTH, DOCK_HEIGHT, 0.0).unwrap();
        for _ in 0..10 {
            let event_result = primary_top_center(&screens, DOCK_WIDTH, DOCK_HEIGHT, 0.0).unwrap();
            assert_eq!(event_result, expected);
            assert_eq!((event_result.width, event_result.height), (520.0, 120.0));
        }
    }

    #[test]
    fn expanded_dock_keeps_fixed_logical_height() {
        let frame = primary_top_center(&[primary()], DOCK_WIDTH, 420.0, 0.0).unwrap();
        assert_eq!((frame.width, frame.height), (520.0, 420.0));
    }

    #[test]
    fn repeated_partials_events_keep_each_requested_logical_size() {
        for expected in [(820.0, 220.0), (460.0, 138.0)] {
            for _ in 0..10 {
                assert_eq!(fixed_logical_size(expected.0, expected.1), Some(expected));
            }
        }
    }
}
