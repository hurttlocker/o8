use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::desktop::get_webview_for_eval;
use crate::socket_server::SocketResponse;
use crate::tools::webview::{eval_and_await, parse_envelope};

#[derive(Debug, Deserialize)]
struct NavigatePayload {
    window_label: Option<String>,
    action: String,
    url: Option<String>,
}

/// Handler for navigate_webview — URL navigation, reload, back/forward
pub async fn handle_navigate_webview<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, crate::error::Error> {
    let parsed: NavigatePayload = serde_json::from_value(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for navigate_webview: {}", e))
    })?;

    let window_label = parsed.window_label.unwrap_or_else(|| "main".to_string());
    let webview = get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    match parsed.action.as_str() {
        "navigate" => {
            let url = parsed.url.ok_or_else(|| {
                crate::error::Error::Anyhow("'url' is required for navigate action".to_string())
            })?;
            let parsed_url: tauri::Url = url.parse().map_err(|e| {
                crate::error::Error::Anyhow(format!("Invalid URL '{}': {}", url, e))
            })?;
            webview
                .navigate(parsed_url)
                .map_err(|e| crate::error::Error::Anyhow(format!("Failed to navigate: {}", e)))?;
            Ok(SocketResponse {
                success: true,
                data: Some(serde_json::json!({"action": "navigate", "url": url})),
                error: None,
                id: None,
            })
        }
        "reload" => {
            webview
                .eval("location.reload()")
                .map_err(|e| crate::error::Error::Anyhow(format!("Failed to reload: {}", e)))?;
            Ok(SocketResponse {
                success: true,
                data: Some(serde_json::json!({"action": "reload"})),
                error: None,
                id: None,
            })
        }
        "get_url" => {
            let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
            Ok(SocketResponse {
                success: true,
                data: Some(serde_json::json!({"url": url})),
                error: None,
                id: None,
            })
        }
        "back" | "forward" => {
            let js_payload = serde_json::json!({
                "action": parsed.action,
            });

            // JS body lifted from handleNavigateWebviewRequest in guest-js/index.ts.
            let js_template = r#"
(async () => {
  try {
    const payload = {{payload}};
    const action = payload.action;
    if (action === 'back') {
      window.history.back();
    } else if (action === 'forward') {
      window.history.forward();
    } else {
      throw new Error('Unknown navigate-webview action: ' + action);
    }
    await window.__TAURI_INTERNALS__.invoke('mcp_result'|'mcp_result', {
      correlationId: {{correlationId}},
      ok: true,
      data: { action },
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
                js_payload,
                std::time::Duration::from_secs(5),
            )
            .await
            {
                Ok(envelope) => Ok(parse_envelope(envelope)),
                Err(e) => Ok(SocketResponse {
                    success: false,
                    data: None,
                    error: Some(format!("eval_and_await failed for navigate_webview: {}", e)),
                    id: None,
                }),
            }
        }
        _ => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(format!(
                "Unknown action '{}'. Valid actions: navigate, reload, get_url, back, forward",
                parsed.action
            )),
            id: None,
        }),
    }
}
