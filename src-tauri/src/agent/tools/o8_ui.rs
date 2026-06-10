//! Symon drives o8's own UI — the o8-control frontier v1.
//!
//! "Open my settings", "show the mobile QR code", "open the browser to
//! anthropic.com": the spoken verb maps to a surface of the o8 window itself.
//! Implementation is a thin event bridge — `o8_ui_open` emits `o8:ui-command`
//! to the MAIN webview, where a dashboard-level listener routes to the same
//! handlers the buttons use (settings overlay, right-panel tabs, mobile
//! pairing canvas tab, browser pane). Nothing here mutates state directly;
//! ReadOnly in `safety` for the same reason `open_app` is — showing a surface
//! has no destructive side effect.

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

/// Surfaces the dashboard listener understands. `voice_settings` short-circuits
/// to the native standalone window (it must work even with the main window
/// closed — same path as the dock double-tap).
const SURFACES: &[&str] = &[
    "settings",
    "voice_settings",
    "mobile_qr",
    "automations",
    "browser",
    "inbox",
    "prs",
    "activity",
    "review",
    "o8md",
    "workspace",
    "files",
    "terminal",
];

pub fn open(app: &tauri::AppHandle, args: Value) -> Result<Value, String> {
    let surface = args
        .get("surface")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if !SURFACES.contains(&surface.as_str()) {
        return Err(format!(
            "I can't open '{surface}' — the o8 surfaces I know are: {}.",
            SURFACES.join(", ")
        ));
    }

    #[cfg(target_os = "macos")]
    if surface == "voice_settings" {
        crate::open_voice_settings(app.clone());
        return Ok(json!({ "opened": "voice_settings" }));
    }

    // A spoken "open …" implies "show me" — surface the main window first so
    // the change is visible even when o8 was hidden to the tray.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }

    let mut payload = json!({ "surface": surface });
    if let Some(url) = args
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        payload["url"] = json!(normalize_url(url));
    }
    let _ = app.emit_to("main", "o8:ui-command", payload);
    log::info!("[symon-o8ui] open {surface}");
    Ok(json!({ "opened": surface }))
}

/// Spoken URLs arrive bare ("anthropic.com") — give them a scheme.
fn normalize_url(u: &str) -> String {
    if u.starts_with("http://") || u.starts_with("https://") {
        u.to_string()
    } else {
        format!("https://{u}")
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_url;

    #[test]
    fn bare_hosts_get_https() {
        assert_eq!(normalize_url("anthropic.com"), "https://anthropic.com");
        assert_eq!(normalize_url("http://localhost:3001"), "http://localhost:3001");
        assert_eq!(normalize_url("https://o8.run"), "https://o8.run");
    }
}
