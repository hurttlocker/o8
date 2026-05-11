use std::borrow::Cow;
use tauri::{Runtime, Webview};

#[derive(Debug, serde::Serialize)]
struct UpdateAvailablePayload<'a> {
    version: &'a str,
    url: &'a str,
}

/// Typed Rust-to-JS state pushes for the main webview.
///
/// To add a new push, add one enum variant and one `to_js` match arm. Keep the
/// JavaScript template fixed per variant, and serialize dynamic fields as JSON
/// before inserting them into the template.
#[allow(dead_code)]
pub enum WebviewLatch {
    AppReady,
    UpdateAvailable { version: String, url: String },
    UpdateClear,
    ConsoleErrorHook,
}

impl WebviewLatch {
    fn to_js(&self) -> Cow<'_, str> {
        match self {
            WebviewLatch::AppReady => Cow::Borrowed("window.__o8AppReady = true;"),
            WebviewLatch::UpdateAvailable { version, url } => {
                let payload = serde_json::to_string(&UpdateAvailablePayload { version, url })
                    .expect("string-only update payload serialization should not fail");
                Cow::Owned(format!("window.__o8Update = {};", payload))
            }
            WebviewLatch::UpdateClear => Cow::Borrowed("delete window.__o8Update;"),
            WebviewLatch::ConsoleErrorHook => Cow::Borrowed(CONSOLE_ERROR_HOOK_JS),
        }
    }

    pub fn fire<R: Runtime>(self, webview: &Webview<R>) -> tauri::Result<()> {
        let js = self.to_js();
        webview.eval(js.as_ref())
    }
}

/// JS injected into every page load on the main window. Wires three error
/// sources back into the Rust ring buffer via `__TAURI_INTERNALS__.invoke`:
///   1. `window.onerror` (synchronous runtime errors, parser errors)
///   2. `unhandledrejection` (async rejections without a `.catch`)
///   3. `console.error` (monkey-patched: original is preserved and still
///      forwarded to devtools so log output is unchanged)
///
/// Each handler stringifies its inputs into a single `message`, derives a
/// `source` (script URL where applicable, otherwise the source label), and
/// fires a fire-and-forget invoke. Failures swallow silently so the hook itself
/// never logs noise that triggers more invokes.
const CONSOLE_ERROR_HOOK_JS: &str = r#"
(function () {
  if (typeof window === 'undefined' || window.__o8ConsoleErrorHookInstalled) return;
  window.__o8ConsoleErrorHookInstalled = true;

  function safeInvoke(message, source, lineno) {
    try {
      if (
        typeof window === 'undefined'
        || !window.__TAURI_INTERNALS__
        || typeof window.__TAURI_INTERNALS__.invoke !== 'function'
      ) {
        return;
      }
      var payload = {
        message: String(message == null ? '' : message).slice(0, 4000),
        source: String(source == null ? '' : source).slice(0, 1000),
        lineno: typeof lineno === 'number' && isFinite(lineno) ? Math.floor(lineno) : 0,
      };
      var p = window.__TAURI_INTERNALS__.invoke('record_console_error', payload);
      if (p && typeof p.then === 'function') p.catch(function () {});
    } catch (e) { /* swallow */ }
  }

  function stringifyArg(value) {
    if (value == null) return String(value);
    if (typeof value === 'string') return value;
    if (value instanceof Error) {
      return value.stack ? value.stack : (value.message || String(value));
    }
    try { return JSON.stringify(value); }
    catch (e) { try { return String(value); } catch (_) { return '[unserializable]'; } }
  }

  var originalConsoleError = console.error;
  console.error = function () {
    try {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(stringifyArg(arguments[i]));
      safeInvoke(parts.join(' '), 'console.error', 0);
    } catch (e) { /* swallow */ }
    try {
      return originalConsoleError.apply(console, arguments);
    } catch (e) {
      // If the original throws (extremely unusual), fall back to noop so we
      // don't spiral. We've already captured the error above.
    }
  };

  window.addEventListener('error', function (event) {
    try {
      var msg = event && (event.message || (event.error && (event.error.stack || event.error.message)));
      var src = event && (event.filename || (event.target && (event.target.src || event.target.href)));
      var line = event && typeof event.lineno === 'number' ? event.lineno : 0;
      safeInvoke(msg, src, line);
    } catch (e) { /* swallow */ }
  }, true);

  window.addEventListener('unhandledrejection', function (event) {
    try {
      var reason = event && event.reason;
      var msg;
      if (reason instanceof Error) {
        msg = reason.stack || reason.message || String(reason);
      } else {
        try { msg = JSON.stringify(reason); }
        catch (_) { msg = String(reason); }
      }
      safeInvoke(msg, 'unhandledrejection', 0);
    } catch (e) { /* swallow */ }
  });
})();
"#;
