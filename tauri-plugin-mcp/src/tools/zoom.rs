use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::desktop::get_webview_for_eval;
use crate::socket_server::SocketResponse;
use crate::tools::webview::{eval_and_await, parse_envelope};

#[derive(Debug, Deserialize)]
struct ZoomPayload {
    window_label: Option<String>,
    action: String,
    scale: Option<f64>,
}

/// Handler for manage_zoom — get/set webview zoom level
pub async fn handle_manage_zoom<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let parsed: ZoomPayload = serde_json::from_value(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for manage_zoom: {}", e))
    })?;

    let window_label = parsed.window_label.unwrap_or_else(|| "main".to_string());
    let webview = get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    match parsed.action.as_str() {
        "set" => {
            let scale = parsed.scale.ok_or_else(|| {
                crate::error::Error::Anyhow("'scale' is required for set action".to_string())
            })?;
            webview
                .set_zoom(scale)
                .map_err(|e| crate::error::Error::Anyhow(format!("Failed to set zoom: {}", e)))?;
            Ok(SocketResponse {
                success: true,
                data: Some(serde_json::json!({"action": "set", "scale": scale})),
                error: None,
                id: None,
            })
        }
        "get" => {
            // JS body lifted from handleManageZoomRequest in guest-js/index.ts.
            let js_template = r#"
(async () => {
  try {
    const visualScale = window.visualViewport ? window.visualViewport.scale : null;
    const data = {
      devicePixelRatio: window.devicePixelRatio,
      visualViewportScale: visualScale,
    };
    await window.__TAURI_INTERNALS__.invoke('mcp_result'|'mcp_result', {
      correlationId: {{correlationId}},
      ok: true,
      data,
      error: null
    });
  } catch (err) {
    await window.__TAURI_INTERNALS__.invoke('mcp_result'|'mcp_result', {
      correlationId: {{correlationId}},
      ok: false,
      data: null,
      error: String(err && err.message ? err.message : err)
    });
  }
})();
"#;

            match eval_and_await(
                app,
                &window_label,
                js_template,
                serde_json::json!({}),
                std::time::Duration::from_secs(5),
            )
            .await
            {
                Ok(envelope) => Ok(parse_envelope(envelope)),
                Err(e) => Ok(SocketResponse {
                    success: false,
                    data: None,
                    error: Some(format!("eval_and_await failed for manage_zoom: {}", e)),
                    id: None,
                }),
            }
        }
        _ => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(format!(
                "Unknown action '{}'. Valid actions: set, get",
                parsed.action
            )),
            id: None,
        }),
    }
}
