//! A capability-free child webview for a single authenticated worker preview.
//! No browser-agent initialization, eval command, shared browser label, or URL
//! logging. Each access id owns a separate window and destruction on unmount.

fn label(id: &str) -> Result<String, String> {
    if id.len() != 48 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid remote preview id".into());
    }
    Ok(format!("remote-preview-{id}"))
}

fn owned_preview_label(name: &str) -> bool {
    name.strip_prefix("remote-preview-")
        .is_some_and(|id| label(id).is_ok())
}

/// React cannot dispose child windows after its document has been replaced.
/// Native ownership ends when the main document starts loading again.
pub(crate) fn close_on_main_reload(app: &tauri::AppHandle) {
    use tauri::Manager;
    let owner = app.clone();
    let _ = app.run_on_main_thread(move || {
        for (name, preview) in owner.webview_windows() {
            if owned_preview_label(&name) {
                if preview.destroy().is_err() {
                    log::warn!("Could not dispose a remote preview during main reload");
                }
            }
        }
    });
}

fn preview_url(raw: &str) -> Result<tauri::Url, String> {
    let url: tauri::Url = raw.parse().map_err(|_| "Invalid remote preview URL")?;
    let ticket = url.query().and_then(|query| query.strip_prefix("ticket="));
    if url.scheme() != "http"
        || url.host_str() != Some("[::1]")
        || url.port().is_none_or(|port| port == 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.path() != "/__o8_connect"
        || ticket.is_none_or(|value| value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err("Invalid remote preview URL".into());
    }
    Ok(url)
}

fn valid_rect(x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    if [x, y, w, h].iter().any(|value| !value.is_finite() || value.abs() > 32_768.0)
        || x < 0.0 || y < 0.0 || w < 1.0 || h < 1.0
    {
        return Err("Invalid remote preview bounds".into());
    }
    Ok(())
}

#[tauri::command]
pub fn remote_preview_supported(window: tauri::Window) -> Result<bool, String> {
    crate::require_main_window(&window)?;
    Ok(cfg!(target_os = "macos"))
}

#[tauri::command]
pub fn remote_preview_open(
    window: tauri::Window, app: tauri::AppHandle, id: String, url: String,
    x: f64, y: f64, w: f64, h: f64,
) -> Result<(), String> {
    crate::require_main_window(&window)?;
    let name = label(&id)?;
    let parsed = preview_url(&url)?;
    valid_rect(x, y, w, h)?;
    #[cfg(target_os = "macos")]
    {
        use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
        if let Some(existing) = app.get_webview_window(&name) {
            crate::browser_view::reposition(&app, &existing, x, y, w, h);
            return existing.show().map_err(|_| "Could not show remote preview".into());
        }
        let origin = parsed.origin();
        let preview = WebviewWindowBuilder::new(&app, name, WebviewUrl::External(parsed))
            .title("o8 remote preview")
            .inner_size(w, h)
            .decorations(false)
            .shadow(false)
            .focused(false)
            .visible(false)
            .disable_drag_drop_handler()
            .on_navigation(move |next| next.origin() == origin)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .build()
            .map_err(|_| "Could not open remote preview")?;
        crate::browser_view::reposition(&app, &preview, x, y, w, h);
        preview.show().map_err(|_| "Could not show remote preview".into())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, name, parsed); Err("Remote previews currently require macOS".into()) }
}

#[tauri::command]
pub fn remote_preview_set_rect(
    window: tauri::Window, app: tauri::AppHandle, id: String,
    x: f64, y: f64, w: f64, h: f64, visible: bool,
) -> Result<(), String> {
    crate::require_main_window(&window)?;
    let name = label(&id)?;
    valid_rect(x, y, w, h)?;
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        if let Some(preview) = app.get_webview_window(&name) {
            if visible {
                crate::browser_view::reposition(&app, &preview, x, y, w, h);
                preview.show().map_err(|_| "Could not show remote preview")?;
            } else {
                preview.hide().map_err(|_| "Could not hide remote preview")?;
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, name, visible); }
    Ok(())
}

#[tauri::command]
pub fn remote_preview_close(window: tauri::Window, app: tauri::AppHandle, id: String) -> Result<(), String> {
    crate::require_main_window(&window)?;
    let name = label(&id)?;
    use tauri::Manager;
    if let Some(preview) = app.get_webview_window(&name) {
        // Destroy page state; an untrusted page cannot veto closure with a handler.
        preview.destroy().map_err(|_| "Could not close remote preview")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_isolated_bootstrap_origin() {
        let ticket = "a".repeat(64);
        assert!(preview_url(&format!("http://[::1]:54321/__o8_connect?ticket={ticket}")).is_ok());
        for host in ["localhost", "127.0.0.1", "example.invalid"] {
            assert!(preview_url(&format!("http://{host}:54321/__o8_connect?ticket={ticket}")).is_err());
        }
        assert!(preview_url(&format!("http://[::1]:54321/__o8_connect?ticket={ticket}&extra=1")).is_err());
        assert!(preview_url("http://[::1]:54321/__o8_connect?ticket=secret").is_err());
    }

    #[test]
    fn ids_cannot_address_other_native_windows() {
        assert!(label(&"a".repeat(48)).unwrap().starts_with("remote-preview-"));
        assert!(label("main").is_err());
        assert!(label("browser-view").is_err());
        assert!(label(&"g".repeat(48)).is_err());
        assert!(valid_rect(0.0, 0.0, 300.0, 200.0).is_ok());
        assert!(valid_rect(f64::NAN, 0.0, 300.0, 200.0).is_err());
    }

    #[test]
    fn reload_cleanup_selects_only_owned_preview_labels() {
        assert!(owned_preview_label(&format!("remote-preview-{}", "a".repeat(48))));
        for name in ["main", "browser-view", "dock", "remote-preview-main", "remote-preview-"] {
            assert!(!owned_preview_label(name));
        }
        assert!(!owned_preview_label(&format!("remote-preview-{}", "g".repeat(48))));
        assert!(!owned_preview_label(&format!("remote-preview-{}-other", "a".repeat(48))));
    }
}
