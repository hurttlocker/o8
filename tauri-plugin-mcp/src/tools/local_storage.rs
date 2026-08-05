use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::error::Error;
use crate::models::LocalStorageRequest;
use crate::socket_server::SocketResponse;
use crate::tools::webview::{eval_and_await, parse_envelope};

pub async fn handle_get_local_storage<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let params: LocalStorageRequest = serde_json::from_value(payload)
        .map_err(|e| Error::Anyhow(format!("Invalid payload for localStorage: {}", e)))?;

    // Validate input parameters
    match params.action.as_str() {
        "get" => {}
        "remove" => {
            if params.key.is_none() {
                return Ok(SocketResponse {
                    success: false,
                    data: None,
                    error: Some("Key is required for remove operations".to_string()),
                    id: None,
                });
            }
        }
        "set" => {
            if params.key.is_none() || params.value.is_none() {
                return Ok(SocketResponse {
                    success: false,
                    data: None,
                    error: Some("Both key and value are required for set operation".to_string()),
                    id: None,
                });
            }
        }
        "clear" | "keys" => {}
        _ => {
            return Ok(SocketResponse {
                success: false,
                data: None,
                error: Some(format!(
                    "Unsupported localStorage action: {}",
                    params.action
                )),
                id: None,
            });
        }
    };

    let window_label = params
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label)
        .ok_or_else(|| Error::Anyhow(format!("Webview not found: {}", window_label)))?;

    let payload_value = serde_json::to_value(&params)
        .map_err(|e| Error::Anyhow(format!("Failed to serialize params: {}", e)))?;

    // JS body lifted from handleLocalStorageRequest + performLocalStorageOperation
    // in guest-js/index.ts. Same JSON-string parsing semantics for key/value.
    let js_template = r#"
(async () => {
  try {
    const payload = {{payload}};
    let { action, key, value } = payload;
    if (typeof key === 'string') {
      try {
        const trimmed = key.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          key = JSON.parse(key);
        }
      } catch (_) { /* keep original */ }
    }
    if (typeof value === 'string') {
      try {
        const trimmed = value.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          value = JSON.parse(value);
        }
      } catch (_) { /* keep original */ }
    }
    let data = null;
    switch (action) {
      case 'get':
        if (!key) {
          const all = {};
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k !== null) all[k] = localStorage.getItem(k) || '';
          }
          data = all;
        } else {
          data = localStorage.getItem(String(key));
        }
        break;
      case 'set':
        if (!key) throw new Error('Key is required for set operation');
        if (value === undefined) throw new Error('Value is required for set operation');
        localStorage.setItem(String(key), String(value));
        break;
      case 'remove':
        if (!key) throw new Error('Key is required for remove operation');
        localStorage.removeItem(String(key));
        break;
      case 'clear':
        localStorage.clear();
        break;
      case 'keys':
        data = Object.keys(localStorage);
        break;
      default:
        throw new Error('Unsupported localStorage action: ' + action);
    }
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
        payload_value,
        std::time::Duration::from_secs(5),
    )
    .await
    {
        Ok(envelope) => Ok(parse_envelope(envelope)),
        Err(e) => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(format!("eval_and_await failed for localStorage: {}", e)),
            id: None,
        }),
    }
}
