use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::error::Error;
use crate::socket_server::SocketResponse;
use crate::tools::webview::eval_and_await;

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExecuteJsRequest {
    window_label: Option<String>,
    code: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ExecuteJsResponse {
    result: String,
    #[serde(rename = "type")]
    result_type: String,
}

/// JS template for `execute_js` driven by `eval_and_await`.
///
/// `{{correlationId}}` is substituted by `eval_and_await` (already JSON-quoted).
/// `{{userCode}}` is substituted here in Rust with a JSON-encoded string literal
/// of the user-supplied code, so the code is embedded safely no matter what
/// quotes or backslashes it contains.
///
/// On success: invokes `plugin:mcp|mcp_result` with `{ok: true, data: {result, type}, error: null}`.
/// On throw:   invokes `plugin:mcp|mcp_result` with `{ok: false, data: null, error: <message>}`.
/// Falls back to the host-app `mcp_result` command when the plugin invoke is
/// rejected (hosts without the remote capability grant — see o8#1733).
const EXECUTE_JS_TEMPLATE: &str = r#"
(function () {
  var __cid = {{correlationId}};
  var __code = {{userCode}};
  // #932 brainstorm A+B: parallel-channel diagnostic — write lifecycle markers
  // to document.title (visible via screenshot tool, bypasses every broken bridge)
  // AND invoke record_console_error (proven main-app command, lands in ring buffer
  // even if plugin command routing is broken). If neither lands → JS isn't running
  // at all and the eval target webview is wrong.
  // o8#1567: the marker must not OUTLIVE the eval — capture the real title once
  // and restore it at every terminal stage, so only a wedged eval (timeout, the
  // case the diagnostic exists for) leaves a marker behind.
  var __title0 = null;
  try { __title0 = document.title; } catch (_) {}
  function __restoreTitle() {
    try {
      if (__title0 !== null && document.title.indexOf('[mcp-') === 0) document.title = __title0;
    } catch (_) {}
  }
  function __diag(stage) {
    try { document.title = '[mcp-' + stage + '] ' + __cid; } catch (_) {}
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke('record_console_error', {
          message: '[mcp-' + stage + '] cid=' + __cid,
          source: 'tauri-plugin-mcp',
          lineno: 0
        });
      }
    } catch (_) {}
  }
  __diag('entered');
  function __send(ok, data, error) {
    __diag('pre');
    var __p;
    try {
      // o8#1733: the result rides the PLUGIN command (`plugin:mcp|mcp_result`),
      // whose `mcp:default` permission the host app grants with a `remote`
      // capability block. The page is served from http://127.0.0.1:<port>,
      // which Tauri treats as a REMOTE origin — and since Tauri 2.11 remote
      // content can never invoke host-app commands at all, which is what
      // silently killed the #932-era host-command channel. The host-app
      // `mcp_result` is kept as a fallback for pre-remote-grant hosts (it
      // still works when the page origin matches devUrl, i.e. dev builds).
      var __args = {
        correlationId: __cid,
        ok: ok,
        data: data,
        error: error
      };
      var __inv = window.__TAURI_INTERNALS__.invoke;
      __p = __inv('plugin:mcp|mcp_result', __args).catch(function (e1) {
        __diag('plugin-rejected-' + String((e1 && e1.message) || e1).slice(0, 40));
        return __inv('mcp_result', __args);
      });
    } catch (e) {
      __diag('throw-' + (e && e.message ? String(e.message).slice(0, 60) : 'sync'));
      console.error('[TAURI_MCP] mcp_result invoke failed:', e);
      setTimeout(__restoreTitle, 1500);
      return;
    }
    if (__p && typeof __p.then === 'function') {
      __p.then(function () { __diag('resolved'); __restoreTitle(); })
         .catch(function (e) {
           var m = (e && e.message) ? String(e.message) : String(e);
           __diag('rejected-' + m.slice(0, 60));
           setTimeout(__restoreTitle, 1500);
         });
    } else {
      __restoreTitle();
    }
  }
  function __stringify(value) {
    var t = typeof value;
    if (t === 'object') {
      try { return JSON.stringify(value); }
      catch (e) { try { return String(value); } catch (_) { return '[unserializable object]'; } }
    }
    if (t === 'undefined') return 'undefined';
    if (t === 'function') { try { return value.toString(); } catch (_) { return '[function]'; } }
    try { return String(value); } catch (_) { return '[unstringifiable]'; }
  }
  function __run() {
    // Try as expression first; on syntax error, run as statements.
    try {
      return (new Function('return (' + __code + ')'))();
    } catch (e) {
      if (e instanceof SyntaxError) {
        return (new Function(__code))();
      }
      throw e;
    }
  }
  try {
    var __result = __run();
    if (__result && typeof __result.then === 'function') {
      __result.then(function (v) {
        __send(true, { result: __stringify(v), type: typeof v }, null);
      }).catch(function (e) {
        var msg = (e && e.toString) ? e.toString() : String(e);
        __send(false, null, msg);
      });
    } else {
      __send(true, { result: __stringify(__result), type: typeof __result }, null);
    }
  } catch (e) {
    var msg = (e && e.toString) ? e.toString() : String(e);
    __send(false, null, msg);
  }
})();
"#;

pub async fn handle_execute_js<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    let request: ExecuteJsRequest = serde_json::from_value(payload)
        .map_err(|e| Error::Anyhow(format!("Invalid payload for executeJs: {}", e)))?;

    let window_label = request
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());

    let timeout_ms = request.timeout_ms.unwrap_or(15000);

    // Embed the user code as a JS string literal. serde_json::to_string of a
    // String gives us a properly-escaped, JSON-quoted form which is also a
    // valid JS string literal.
    let user_code_literal = serde_json::to_string(&request.code)
        .map_err(|e| Error::Anyhow(format!("Failed to encode user code as JS literal: {}", e)))?;

    let template = EXECUTE_JS_TEMPLATE.replace("{{userCode}}", &user_code_literal);

    // `eval_and_await` substitutes `{{correlationId}}` and an unused `{{payload}}`.
    // We pass an empty object for the payload — execute_js bakes `userCode`
    // directly into the template instead of going through the payload channel.
    match eval_and_await(
        app,
        &window_label,
        &template,
        serde_json::json!({}),
        std::time::Duration::from_millis(timeout_ms),
    )
    .await
    {
        Ok(envelope) => {
            // `mcp_result` wraps everything as {ok, data, error}.
            let ok = envelope
                .get("ok")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if !ok {
                let error_msg = envelope
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error from execute_js")
                    .to_string();
                return Ok(SocketResponse {
                    success: false,
                    data: None,
                    error: Some(error_msg),
                    id: None,
                });
            }

            let data_obj = envelope.get("data").cloned().unwrap_or(Value::Null);

            let result = data_obj
                .get("result")
                .and_then(|r| r.as_str())
                .unwrap_or("[Result could not be stringified]")
                .to_string();

            let result_type = data_obj
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("unknown")
                .to_string();

            let data = serde_json::to_value(ExecuteJsResponse {
                result,
                result_type,
            })
            .map_err(|e| Error::Anyhow(format!("Failed to serialize response: {}", e)))?;

            Ok(SocketResponse {
                success: true,
                data: Some(data),
                error: None,
                id: None,
            })
        }
        Err(e) => {
            // eval_and_await timeouts include the correlation id in their message;
            // surface a stable, recognizable string so callers can detect it.
            let msg = e.to_string();
            let surfaced = if msg.contains("Timeout waiting for") {
                "Timeout waiting for execute-js response (eval-based)".to_string()
            } else {
                msg
            };
            Ok(SocketResponse {
                success: false,
                data: None,
                error: Some(surfaced),
                id: None,
            })
        }
    }
}
