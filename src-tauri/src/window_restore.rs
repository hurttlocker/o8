use serde::Deserialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

const MIN_WIDTH: f64 = 400.0;
const MIN_HEIGHT: f64 = 300.0;
const MAX_WORK_AREA_RATIO: f64 = 0.8;

#[derive(Clone, Copy, Debug, Deserialize)]
struct SavedWindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, Debug)]
struct LogicalRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug)]
struct RestoreDecision {
    rect: LogicalRect,
    changed: bool,
    clear_zoom_state: bool,
}

pub(crate) fn clamp_main_window(app: &AppHandle, window: &WebviewWindow) {
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    if monitors.is_empty() {
        return;
    }

    let saved = read_saved_main_state(app);
    let Ok(current_pos) = window.outer_position() else {
        return;
    };
    let Ok(current_size) = window.outer_size() else {
        return;
    };

    let saved_physical =
        saved.map(|state| (state.x, state.y, state.width.max(1), state.height.max(1)));
    let current_physical = (
        current_pos.x,
        current_pos.y,
        current_size.width.max(1),
        current_size.height.max(1),
    );
    let probe = saved_physical.unwrap_or(current_physical);
    let (target, disconnected) = target_monitor(window, &monitors, probe);
    let Some(target) = target else { return };

    let scale = target.scale_factor().max(1.0);
    let work = target.work_area();
    let work_rect = LogicalRect {
        x: work.position.x as f64 / scale,
        y: work.position.y as f64 / scale,
        width: work.size.width as f64 / scale,
        height: work.size.height as f64 / scale,
    };
    let current_rect = LogicalRect {
        x: current_pos.x as f64 / scale,
        y: current_pos.y as f64 / scale,
        width: current_size.width as f64 / scale,
        height: current_size.height as f64 / scale,
    };

    let decision = decide_restore_rect(current_rect, work_rect, disconnected);
    if decision.clear_zoom_state {
        if window.is_fullscreen().unwrap_or(false) {
            let _ = window.set_fullscreen(false);
        }
        if window.is_maximized().unwrap_or(false) {
            let _ = window.unmaximize();
        }
    }
    if decision.changed {
        let _ = window.set_size(LogicalSize::new(decision.rect.width, decision.rect.height));
        let _ = window.set_position(LogicalPosition::new(decision.rect.x, decision.rect.y));
        log::info!(
            "[window-restore] clamped main window to {:.0}x{:.0} at {:.0},{:.0}",
            decision.rect.width,
            decision.rect.height,
            decision.rect.x,
            decision.rect.y
        );
    }
}

fn read_saved_main_state(app: &AppHandle) -> Option<SavedWindowState> {
    let path = app
        .path()
        .app_config_dir()
        .ok()?
        .join(tauri_plugin_window_state::DEFAULT_FILENAME);
    let content = std::fs::read_to_string(path).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&content).ok()?;
    serde_json::from_value(json.get("main")?.clone()).ok()
}

fn target_monitor(
    window: &WebviewWindow,
    monitors: &[tauri::Monitor],
    rect: (i32, i32, u32, u32),
) -> (Option<tauri::Monitor>, bool) {
    let best = monitors
        .iter()
        .map(|monitor| (monitor, intersection_area(rect, monitor)))
        .max_by_key(|(_, area)| *area);
    if let Some((monitor, area)) = best.filter(|(_, area)| *area > 0) {
        return (Some(monitor.clone()), false);
    }

    let fallback = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.first().cloned());
    (fallback, true)
}

fn intersection_area(rect: (i32, i32, u32, u32), monitor: &tauri::Monitor) -> i64 {
    let work = monitor.work_area();
    let left = (rect.0 as i64).max(work.position.x as i64);
    let top = (rect.1 as i64).max(work.position.y as i64);
    let right =
        (rect.0 as i64 + rect.2 as i64).min(work.position.x as i64 + work.size.width as i64);
    let bottom =
        (rect.1 as i64 + rect.3 as i64).min(work.position.y as i64 + work.size.height as i64);
    (right - left).max(0) * (bottom - top).max(0)
}

fn decide_restore_rect(
    current: LogicalRect,
    work: LogicalRect,
    disconnected: bool,
) -> RestoreDecision {
    let exceeds_work = current.width > work.width || current.height > work.height;
    if disconnected || exceeds_work {
        let width = clamp_dimension(current.width, work.width, MIN_WIDTH);
        let height = clamp_dimension(current.height, work.height, MIN_HEIGHT);
        return RestoreDecision {
            rect: LogicalRect {
                x: work.x + (work.width - width).max(0.0) / 2.0,
                y: work.y + (work.height - height).max(0.0) / 2.0,
                width,
                height,
            },
            changed: true,
            clear_zoom_state: disconnected,
        };
    }

    let x = current
        .x
        .max(work.x)
        .min((work.x + work.width - current.width).max(work.x));
    let y = current
        .y
        .max(work.y)
        .min((work.y + work.height - current.height).max(work.y));
    RestoreDecision {
        rect: LogicalRect {
            x,
            y,
            width: current.width,
            height: current.height,
        },
        changed: (x - current.x).abs() > f64::EPSILON || (y - current.y).abs() > f64::EPSILON,
        clear_zoom_state: false,
    }
}

fn clamp_dimension(saved: f64, work: f64, min: f64) -> f64 {
    saved.min(work * MAX_WORK_AREA_RATIO).max(min.min(work))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centers_oversized_window_at_eighty_percent_of_work_area() {
        let decision = decide_restore_rect(
            LogicalRect {
                x: 10.0,
                y: 20.0,
                width: 4000.0,
                height: 1600.0,
            },
            LogicalRect {
                x: 0.0,
                y: 24.0,
                width: 1440.0,
                height: 876.0,
            },
            false,
        );

        assert!(decision.changed);
        assert!(!decision.clear_zoom_state);
        assert_eq!(decision.rect.width, 1152.0);
        assert!((decision.rect.height - 700.8).abs() < 0.001);
        assert_eq!(decision.rect.x, 144.0);
        assert!((decision.rect.y - 111.6).abs() < 0.001);
    }

    #[test]
    fn centers_disconnected_window_and_clears_zoom_state() {
        let decision = decide_restore_rect(
            LogicalRect {
                x: 5000.0,
                y: 200.0,
                width: 900.0,
                height: 700.0,
            },
            LogicalRect {
                x: 0.0,
                y: 0.0,
                width: 1200.0,
                height: 800.0,
            },
            true,
        );

        assert!(decision.changed);
        assert!(decision.clear_zoom_state);
        assert_eq!(decision.rect.width, 900.0);
        assert_eq!(decision.rect.height, 640.0);
        assert_eq!(decision.rect.x, 150.0);
        assert_eq!(decision.rect.y, 80.0);
    }

    #[test]
    fn clamps_position_without_resizing_when_window_fits() {
        let decision = decide_restore_rect(
            LogicalRect {
                x: -80.0,
                y: 10.0,
                width: 800.0,
                height: 600.0,
            },
            LogicalRect {
                x: 0.0,
                y: 24.0,
                width: 1440.0,
                height: 876.0,
            },
            false,
        );

        assert!(decision.changed);
        assert_eq!(decision.rect.width, 800.0);
        assert_eq!(decision.rect.height, 600.0);
        assert_eq!(decision.rect.x, 0.0);
        assert_eq!(decision.rect.y, 24.0);
    }

    #[test]
    fn leaves_valid_window_unchanged() {
        let decision = decide_restore_rect(
            LogicalRect {
                x: 80.0,
                y: 80.0,
                width: 900.0,
                height: 650.0,
            },
            LogicalRect {
                x: 0.0,
                y: 24.0,
                width: 1440.0,
                height: 876.0,
            },
            false,
        );

        assert!(!decision.changed);
        assert!(!decision.clear_zoom_state);
    }
}
