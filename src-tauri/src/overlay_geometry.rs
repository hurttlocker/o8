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

/// Place caret feedback in the AX/AppKit logical desktop coordinate space.
/// Backing scale affects rasterization, never global point origins. If AX has
/// no usable anchor, follow the pointer's screen rather than o8's main window.
pub fn caret_local_frame(
    screens: &[LogicalScreen],
    anchor: Option<LogicalWindowFrame>,
    pointer: (f64, f64),
    size: (f64, f64),
    gap: f64,
) -> Option<LogicalWindowFrame> {
    let (width, height) = fixed_logical_size(size.0, size.1)?;
    let contains = |screen: &&LogicalScreen, point: (f64, f64)| {
        point.0 >= screen.x && point.0 < screen.x + screen.width
            && point.1 >= screen.y && point.1 < screen.y + screen.height
    };
    let anchor = anchor.filter(|a| {
        a.x.is_finite() && a.y.is_finite() && a.width.is_finite()
            && a.height.is_finite() && a.width >= 0.0 && a.height > 0.0
    });
    let anchored = anchor.and_then(|a| {
        screens.iter().find(|screen| contains(screen, (a.x, a.y))).map(|screen| (screen, a))
    });
    let screen = anchored.map(|(screen, _)| screen)
        .or_else(|| screens.iter().find(|screen| contains(screen, pointer)))
        .or_else(|| screens.iter().find(|screen| screen.is_primary))
        .or_else(|| screens.first())?;
    if screen.width <= 0.0 || screen.height <= 0.0 {
        return None;
    }
    let max_x = (screen.x + screen.width - width).max(screen.x);
    let max_y = (screen.y + screen.height - height).max(screen.y);
    let (x, y) = if let Some((_, a)) = anchored {
        let below = a.y + a.height + gap;
        let y = if below + height <= screen.y + screen.height { below } else { a.y - height - gap };
        ((a.x + a.width + gap).clamp(screen.x, max_x), y.clamp(screen.y, max_y))
    } else {
        ((screen.x + (screen.width - width) / 2.0).clamp(screen.x, max_x),
            (screen.y + screen.height - height - 48.0).clamp(screen.y, max_y))
    };
    Some(LogicalWindowFrame { x, y, width, height })
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
    use super::{caret_local_frame, fixed_logical_size, primary_top_center, LogicalScreen, LogicalWindowFrame};

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

    #[test]
    fn caret_placement_follows_left_display_in_mixed_scale_desktop() {
        let screens = [primary(), LogicalScreen {
            x: -2560.0, y: -188.0, width: 2560.0, height: 1440.0,
            scale_factor: 1.0, is_primary: false,
        }];
        let anchor = LogicalWindowFrame { x: -1600.0, y: 900.0, width: 1.0, height: 20.0 };
        let frame = caret_local_frame(&screens, Some(anchor), (1000.0, 900.0), (460.0, 138.0), 8.0).unwrap();
        assert_eq!(frame, LogicalWindowFrame { x: -1591.0, y: 928.0, width: 460.0, height: 138.0 });
        let main_caret = LogicalWindowFrame { x: 1800.0, y: 1200.0, ..anchor };
        let frame = caret_local_frame(&screens, Some(main_caret), (-1600.0, 900.0), (460.0, 138.0), 8.0).unwrap();
        assert_eq!((frame.x, frame.y), (1809.0, 1228.0));
    }

    #[test]
    fn missing_caret_follows_pointer_screen_and_clamps_without_scale_conversion() {
        let above = LogicalScreen { x: 0.0, y: -1440.0, width: 2560.0, height: 1440.0, scale_factor: 1.0, is_primary: false };
        let screens = [primary(), above];
        let frame = caret_local_frame(&screens, None, (1000.0, -500.0), (460.0, 138.0), 8.0).unwrap();
        assert_eq!((frame.x, frame.y), (1050.0, -186.0));
        let edge = LogicalWindowFrame { x: 2555.0, y: -30.0, width: 1.0, height: 20.0 };
        let frame = caret_local_frame(&screens, Some(edge), (0.0, 0.0), (460.0, 138.0), 8.0).unwrap();
        assert_eq!((frame.x, frame.y), (2100.0, -176.0));
        for _ in 0..10 {
            assert_eq!(caret_local_frame(&screens, Some(edge), (0.0, 0.0), (460.0, 138.0), 8.0).unwrap(), frame);
        }
    }
}
