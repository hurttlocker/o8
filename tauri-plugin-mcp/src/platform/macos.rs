use crate::models::ScreenshotResponse;
use crate::{Error, Result};
use core_graphics::base::CGFloat;
use core_graphics::display::{
    CGPoint, CGRect, CGSize, CGWindowListCopyWindowInfo, CGWindowListCreateImage, kCGNullWindowID,
    kCGWindowImageBoundsIgnoreFraming, kCGWindowImageDefault, kCGWindowListExcludeDesktopElements,
    kCGWindowListOptionAll, kCGWindowListOptionIncludingWindow,
};
use image;
use log::{debug, error, info};
use tauri::Runtime;

// Import shared functionality
use crate::desktop::ScreenshotContext;
use crate::platform::shared::{
    finalize_screenshot, get_window_title_from_handle, handle_screenshot_task,
};
use crate::shared::ScreenshotParams;

/// Window info extracted from CGWindowListCopyWindowInfo
#[derive(Debug, Clone)]
struct WindowInfo {
    window_id: u32,
    owner_pid: i64,
    owner_name: String,
    name: String,
    layer: i32,
    bounds: (f64, f64, f64, f64), // x, y, width, height
}

/// Get all windows using CGWindowListCopyWindowInfo with kCGWindowListOptionAll
/// This finds windows that xcap's kCGWindowListOptionOnScreenOnly misses (like Tauri windows)
fn get_all_windows_cg() -> Vec<WindowInfo> {
    use core_foundation::array::CFArray;
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    let mut windows = Vec::new();

    unsafe {
        let options = kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements;
        let window_list = CGWindowListCopyWindowInfo(options, kCGNullWindowID);

        if window_list.is_null() {
            return windows;
        }

        let array: CFArray = CFArray::wrap_under_create_rule(window_list);

        for i in 0..array.len() {
            let dict_ref = match array.get(i as isize) {
                Some(r) => r,
                None => continue,
            };

            // Cast to CFDictionary - the dict_ref is a raw pointer
            let dict_ptr = *dict_ref as *const core_foundation::dictionary::__CFDictionary;
            let dict: CFDictionary<CFString, *const std::ffi::c_void> =
                CFDictionary::wrap_under_get_rule(dict_ptr);

            // Extract window properties
            let owner_pid = get_number_from_dict(&dict, "kCGWindowOwnerPID").unwrap_or(0);
            let owner_name = get_string_from_dict(&dict, "kCGWindowOwnerName").unwrap_or_default();
            let name = get_string_from_dict(&dict, "kCGWindowName").unwrap_or_default();
            let layer = get_number_from_dict(&dict, "kCGWindowLayer").unwrap_or(-1) as i32;
            let window_id = get_number_from_dict(&dict, "kCGWindowNumber").unwrap_or(0) as u32;

            // Get bounds
            let bounds = get_bounds_from_dict(&dict);

            windows.push(WindowInfo {
                window_id,
                owner_pid,
                owner_name,
                name,
                layer,
                bounds,
            });
        }
    }

    windows
}

fn get_string_from_dict(
    dict: &core_foundation::dictionary::CFDictionary<
        core_foundation::string::CFString,
        *const std::ffi::c_void,
    >,
    key: &str,
) -> Option<String> {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;

    let cf_key = CFString::new(key);
    unsafe {
        if let Some(value) = dict.find(cf_key) {
            let cf_str: CFString = CFString::wrap_under_get_rule(*value as *const _);
            Some(cf_str.to_string())
        } else {
            None
        }
    }
}

fn get_number_from_dict(
    dict: &core_foundation::dictionary::CFDictionary<
        core_foundation::string::CFString,
        *const std::ffi::c_void,
    >,
    key: &str,
) -> Option<i64> {
    use core_foundation::base::TCFType;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;

    let cf_key = CFString::new(key);
    unsafe {
        if let Some(value) = dict.find(cf_key) {
            let cf_num: CFNumber = CFNumber::wrap_under_get_rule(*value as *const _);
            cf_num.to_i64()
        } else {
            None
        }
    }
}

fn get_bounds_from_dict(
    dict: &core_foundation::dictionary::CFDictionary<
        core_foundation::string::CFString,
        *const std::ffi::c_void,
    >,
) -> (f64, f64, f64, f64) {
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    let cf_key = CFString::new("kCGWindowBounds");
    unsafe {
        if let Some(bounds_ref) = dict.find(cf_key) {
            let bounds_dict: CFDictionary<CFString, *const std::ffi::c_void> =
                CFDictionary::wrap_under_get_rule(*bounds_ref as *const _);

            let x = get_number_from_dict(&bounds_dict, "X").unwrap_or(0) as f64;
            let y = get_number_from_dict(&bounds_dict, "Y").unwrap_or(0) as f64;
            let width = get_number_from_dict(&bounds_dict, "Width").unwrap_or(0) as f64;
            let height = get_number_from_dict(&bounds_dict, "Height").unwrap_or(0) as f64;

            (x, y, width, height)
        } else {
            (0.0, 0.0, 0.0, 0.0)
        }
    }
}

/// Resolve OUR OWN window in the CG list without trusting titles.
///
/// Title search breaks as soon as the app has a second window whose title
/// shares a prefix (e.g. main "o8" vs dictation dock "o8 dictation", which is
/// always-on-top and therefore sorts first in z-order) — see the 2026-06-11
/// dock-capture regression. Own-process windows always expose pid + layer +
/// bounds regardless of Screen Recording permission, so match on those:
///   1. normal-layer (layer 0) windows owned by this pid
///   2. exact title match within that set
///   3. outer-size match (±2pt) within that set — titles can be stale/empty
///   4. single remaining candidate
fn find_own_window_cg(
    windows: &[WindowInfo],
    window_title: &str,
    size_points: Option<(f64, f64)>,
) -> Option<WindowInfo> {
    let my_pid = std::process::id() as i64;
    let own: Vec<&WindowInfo> = windows
        .iter()
        .filter(|w| w.owner_pid == my_pid && w.layer == 0)
        .collect();

    if own.is_empty() {
        return None;
    }
    if let Some(w) = own
        .iter()
        .find(|w| !window_title.is_empty() && w.name == window_title)
    {
        return Some((*w).clone());
    }
    if let Some((tw, th)) = size_points {
        if let Some(w) = own
            .iter()
            .find(|w| (w.bounds.2 - tw).abs() <= 2.0 && (w.bounds.3 - th).abs() <= 2.0)
        {
            return Some((*w).clone());
        }
    }
    if own.len() == 1 {
        return Some(own[0].clone());
    }
    None
}

/// Capture a window by its CGWindowID
fn capture_window_by_id(window_id: u32, bounds: (f64, f64, f64, f64)) -> Result<image::RgbaImage> {
    use foreign_types_shared::ForeignType;

    let (x, y, width, height) = bounds;

    let rect = CGRect {
        origin: CGPoint {
            x: x as CGFloat,
            y: y as CGFloat,
        },
        size: CGSize {
            width: width as CGFloat,
            height: height as CGFloat,
        },
    };

    unsafe {
        // kCGWindowListOptionIncludingWindow + the window's own bounds renders
        // ONLY this window's composited content — even when other windows
        // overlap it on screen. The previous kCGWindowListOptionAll IGNORED the
        // window_id param entirely and produced a desktop-region capture of
        // whatever was stacked in that rect (latent since this fn landed; the
        // xcap path masked it because xcap captures are window-scoped).
        let image_ref = CGWindowListCreateImage(
            rect,
            kCGWindowListOptionIncludingWindow,
            window_id,
            kCGWindowImageDefault | kCGWindowImageBoundsIgnoreFraming,
        );

        if image_ref.is_null() {
            return Err(Error::WindowOperationFailed(
                "Failed to capture window image".to_string(),
            ));
        }

        let cg_image = core_graphics::image::CGImage::from_ptr(image_ref);

        let img_width = cg_image.width();
        let img_height = cg_image.height();
        let bytes_per_row = cg_image.bytes_per_row();
        let data = cg_image.data();

        // Convert CGImage data to RgbaImage
        // CGImage data is typically BGRA
        let data_slice = data.bytes();
        let data_len = data_slice.len();
        let mut rgba_data = Vec::with_capacity(img_width * img_height * 4);

        for row in 0..img_height {
            for col in 0..img_width {
                let offset = row * bytes_per_row + col * 4;
                if offset + 3 < data_len {
                    let b = data_slice[offset];
                    let g = data_slice[offset + 1];
                    let r = data_slice[offset + 2];
                    let a = data_slice[offset + 3];
                    rgba_data.push(r);
                    rgba_data.push(g);
                    rgba_data.push(b);
                    rgba_data.push(a);
                }
            }
        }

        image::RgbaImage::from_raw(img_width as u32, img_height as u32, rgba_data).ok_or_else(
            || Error::WindowOperationFailed("Failed to create image from raw data".to_string()),
        )
    }
}

// macOS-specific implementation for taking screenshots
pub async fn take_screenshot<R: Runtime>(
    params: ScreenshotParams,
    window_context: ScreenshotContext<R>,
) -> Result<ScreenshotResponse> {
    // Clone necessary parameters for use in the closure
    let params_clone = params.clone();
    let window_label = params
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    // Get application name from params or use a default
    let application_name = params.application_name.clone().unwrap_or_default();

    // Get window title from the handle (works with both Window and WebviewWindow)
    let window_title = get_window_title_from_handle(&window_context.window_handle)?;

    // Outer size in points for the label-resolved window — feeds the
    // title-free own-window matcher below. Best-effort: None on failure.
    let size_points: Option<(f64, f64)> = {
        let (size, scale) = match &window_context.window_handle {
            crate::desktop::WindowHandle::WebviewWindow(w) => {
                (w.outer_size().ok(), w.scale_factor().ok())
            }
            crate::desktop::WindowHandle::Window(w) => (w.outer_size().ok(), w.scale_factor().ok()),
        };
        match (size, scale) {
            (Some(s), Some(f)) if f > 0.0 => Some((s.width as f64 / f, s.height as f64 / f)),
            _ => None,
        }
    };

    handle_screenshot_task(move || {
        info!("[TAURI-MCP] Looking for window with title: {} (label: {})", window_title, window_label);

        // Own-process CG match first: the label-resolved window is OURS, so
        // never trust a z-ordered title search to re-find it (the always-on-
        // top dictation dock used to win the partial match and get captured
        // instead of main). pid + layer + size identify it without titles.
        let cg_windows = get_all_windows_cg();
        if let Some(window_info) = find_own_window_cg(&cg_windows, &window_title, size_points) {
            info!("[TAURI-MCP] Found own window via CG pid match: id={}, name='{}'",
                  window_info.window_id, window_info.name);
            let image = capture_window_by_id(window_info.window_id, window_info.bounds)?;
            info!("[TAURI-MCP] Successfully captured window image: {}x{}",
                  image.width(), image.height());
            let dynamic_image = image::DynamicImage::ImageRgba8(image);
            return finalize_screenshot(dynamic_image, &params_clone);
        }
        info!("[TAURI-MCP] Own-window CG match failed; falling back to title search");

        // First try xcap (works for most windows)
        let xcap_windows = xcap::Window::all().unwrap_or_default();
        info!("[TAURI-MCP] Found {} windows through xcap", xcap_windows.len());

        // Try to find window using xcap first
        if let Some(window) = find_window(&xcap_windows, &window_title, &application_name) {
            info!("[TAURI-MCP] Found window via xcap, capturing...");
            let image = match window.capture_image() {
                Ok(img) => img,
                Err(e) => return Err(Error::WindowOperationFailed(format!("Failed to capture window image: {}", e))),
            };

            info!("[TAURI-MCP] Successfully captured window image: {}x{}",
                  image.width(), image.height());

            let dynamic_image = image::DynamicImage::ImageRgba8(image);
            return finalize_screenshot(dynamic_image, &params_clone);
        }

        // xcap didn't find it - try using CGWindowListCopyWindowInfo with kCGWindowListOptionAll
        // This finds Tauri windows that xcap misses
        info!("[TAURI-MCP] xcap didn't find window, trying CGWindowListCopyWindowInfo with kCGWindowListOptionAll...");

        let cg_windows = get_all_windows_cg();
        info!("[TAURI-MCP] Found {} windows through CGWindowListCopyWindowInfo", cg_windows.len());

        // Find the target window in the CG list
        if let Some(window_info) = find_window_cg(&cg_windows, &window_title, &application_name) {
            info!("[TAURI-MCP] Found window via CG: id={}, name='{}', owner='{}'",
                  window_info.window_id, window_info.name, window_info.owner_name);

            // Capture using CGWindowListCreateImage
            let image = capture_window_by_id(window_info.window_id, window_info.bounds)?;

            info!("[TAURI-MCP] Successfully captured window image: {}x{}",
                  image.width(), image.height());

            let dynamic_image = image::DynamicImage::ImageRgba8(image);
            return finalize_screenshot(dynamic_image, &params_clone);
        }

        // Check if it's a permissions issue
        let only_menubar = xcap_windows.len() <= 1 && xcap_windows.iter().all(|w|
            w.app_name() == "Window Server" || w.title() == "Menubar"
        );

        if only_menubar {
            Err(Error::WindowOperationFailed(
                "Screen Recording permission required. Please grant permission in: \
                System Preferences > Privacy & Security > Screen Recording, \
                then restart the app.".to_string()
            ))
        } else {
            Err(Error::WindowOperationFailed(
                format!("Window not found. Searched for title='{}', app='{}'. \
                Found {} xcap windows and {} CG windows.",
                window_title, application_name, xcap_windows.len(), cg_windows.len())
            ))
        }
    }).await
}

// Helper function to find the window in the xcap window list - optimized version
fn find_window(
    xcap_windows: &[xcap::Window],
    window_title: &str,
    application_name: &str,
) -> Option<xcap::Window> {
    let application_name_lower = application_name.to_lowercase();
    let window_title_lower = window_title.to_lowercase();

    info!(
        "[TAURI-MCP] Searching for window with title: '{}', app_name: '{}' (case-insensitive)",
        window_title, application_name
    );

    // Log all windows to help with troubleshooting
    debug!("[TAURI-MCP] ============= ALL WINDOWS =============");
    for window in xcap_windows {
        debug!(
            "[TAURI-MCP] Window: title='{}', app_name='{}', minimized={}",
            window.title(),
            window.app_name(),
            window.is_minimized()
        );
    }
    debug!("[TAURI-MCP] ======================================");

    // Check if we might have a permissions issue (only Window Server menubar visible)
    if xcap_windows.len() <= 1 {
        let only_menubar = xcap_windows
            .iter()
            .all(|w| w.app_name() == "Window Server" || w.title() == "Menubar");
        if only_menubar {
            error!("[TAURI-MCP] Permission issue detected: Only Window Server menubar is visible.");
            error!("[TAURI-MCP] Please grant Screen Recording permission to this app in:");
            error!("[TAURI-MCP] System Preferences > Privacy & Security > Screen Recording");
        }
    }

    // Step 1: First pass - direct application name match (highest priority)
    if !application_name_lower.is_empty() {
        for window in xcap_windows {
            if window.is_minimized() {
                continue;
            }

            let app_name = window.app_name().to_lowercase();

            // Direct match for application name - highest priority
            if app_name.contains(&application_name_lower) {
                info!(
                    "[TAURI-MCP] Found window by app name: '{}'",
                    window.app_name()
                );
                return Some(window.clone());
            }
        }
    }

    // Step 2: Second pass - exact window title match
    for window in xcap_windows {
        if window.is_minimized() {
            continue;
        }

        if window.title() == window_title {
            info!(
                "[TAURI-MCP] Found window by exact title match: '{}'",
                window.title()
            );
            return Some(window.clone());
        }
    }

    // Step 3: Third pass - case-insensitive window title match
    for window in xcap_windows {
        if window.is_minimized() {
            continue;
        }

        if window.title().to_lowercase() == window_title_lower {
            info!(
                "[TAURI-MCP] Found window by case-insensitive title match: '{}'",
                window.title()
            );
            return Some(window.clone());
        }
    }

    // Step 4: Fourth pass - partial window title match (title contains search string)
    for window in xcap_windows {
        if window.is_minimized() {
            continue;
        }

        if window.title().to_lowercase().contains(&window_title_lower) {
            info!(
                "[TAURI-MCP] Found window by partial title match: '{}'",
                window.title()
            );
            return Some(window.clone());
        }
    }

    error!(
        "[TAURI-MCP] No matching window found for title='{}', app_name='{}'",
        window_title, application_name
    );
    None
}

// Helper function to find window in CGWindowListCopyWindowInfo results
fn find_window_cg(
    windows: &[WindowInfo],
    window_title: &str,
    application_name: &str,
) -> Option<WindowInfo> {
    let application_name_lower = application_name.to_lowercase();
    let window_title_lower = window_title.to_lowercase();

    // Only consider layer 0 windows (normal windows)
    let normal_windows: Vec<_> = windows.iter().filter(|w| w.layer == 0).collect();

    info!(
        "[TAURI-MCP] CG: Searching {} normal windows for title='{}', app='{}'",
        normal_windows.len(),
        window_title,
        application_name
    );

    // Step 1: Exact owner name + window name match
    for window in &normal_windows {
        if window.owner_name.to_lowercase() == application_name_lower && window.name == window_title
        {
            return Some((*window).clone());
        }
    }

    // Step 2: Owner name contains app name + exact window name
    for window in &normal_windows {
        if window
            .owner_name
            .to_lowercase()
            .contains(&application_name_lower)
            && window.name == window_title
        {
            return Some((*window).clone());
        }
    }

    // Step 3: Owner name match + partial window name match
    for window in &normal_windows {
        if window
            .owner_name
            .to_lowercase()
            .contains(&application_name_lower)
            && window.name.to_lowercase().contains(&window_title_lower)
        {
            return Some((*window).clone());
        }
    }

    // Step 4: Just partial window name match with non-empty name
    for window in &normal_windows {
        if !window.name.is_empty() && window.name.to_lowercase().contains(&window_title_lower) {
            return Some((*window).clone());
        }
    }

    // Step 5: Owner name match only (for windows with empty title)
    for window in &normal_windows {
        if window.owner_name.to_lowercase() == application_name_lower
            && window.bounds.2 > 100.0
            && window.bounds.3 > 100.0
        {
            // reasonable size
            return Some((*window).clone());
        }
    }

    None
}

// Add any other macOS-specific functionality here
