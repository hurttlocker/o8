use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};
use tokio::sync::oneshot;
use uuid::Uuid;

// ---- Pending-result registry for eval-based correlation ----
//
// Bridges Rust → JS via `webview.eval(js)` and JS → Rust via the
// `mcp_result` `#[tauri::command]`. Used to side-step Tauri v2 bugs
// (#10182, #7835) where window-scoped `app.emit_to` listeners never
// fire — the same pattern used by `o8_view_active_route` /
// `CONSOLE_ERROR_HOOK_JS` in cortex-ide that have shipped reliably.

type PendingMap = Mutex<HashMap<String, oneshot::Sender<Value>>>;

static PENDING: OnceLock<PendingMap> = OnceLock::new();

fn pending_map() -> &'static PendingMap {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Module-level registry of pending eval-based requests, keyed by correlation ID.
pub struct PendingResults;

#[allow(dead_code)] // agents #2/#3 land in parallel after this PR merges
impl PendingResults {
    /// Insert a new pending entry and return the receiver to await on.
    pub fn register(correlation_id: String) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut map) = pending_map().lock() {
            map.insert(correlation_id, tx);
        }
        rx
    }

    /// Resolve a pending entry by sending `value` through its oneshot sender.
    /// Logs a warning if no sender is found (orphan response).
    pub fn complete(correlation_id: &str, value: Value) {
        let sender = pending_map()
            .lock()
            .ok()
            .and_then(|mut map| map.remove(correlation_id));
        match sender {
            Some(tx) => {
                if tx.send(value).is_err() {
                    log::warn!(
                        "[TAURI_MCP] mcp_result receiver dropped before response (correlation_id={})",
                        correlation_id
                    );
                }
            }
            None => {
                log::warn!(
                    "[TAURI_MCP] mcp_result orphan response (correlation_id={}) — receiver already cleaned up or never registered",
                    correlation_id
                );
            }
        }
    }

    /// Drop a pending entry without resolving it (used on timeout to prevent leaks).
    pub fn cancel(correlation_id: &str) {
        if let Ok(mut map) = pending_map().lock() {
            map.remove(correlation_id);
        }
    }
}

/// Run a JS template inside a webview and await its `mcp_result` reply.
///
/// 1. Generates a UUID `correlation_id`.
/// 2. Substitutes `{{correlationId}}` / `{{payload}}` into `js_template`.
///    The template MUST self-invoke and call
///    `window.__TAURI_INTERNALS__.invoke('mcp_result'|'mcp_result',
///    {correlationId, ok, data?, error?})` on both success and failure.
/// 3. Resolves the webview by `window_label` via `app.get_webview_window` —
///    returns Err if missing. (This intentionally does NOT use the
///    multi-webview fallback; agents #2/#3 can layer that on per-tool.)
/// 4. Calls `webview.eval` (fire-and-forget) and awaits the oneshot
///    receiver registered with `PendingResults`.
/// 5. On timeout: removes the pending entry to prevent map leaks.
#[allow(dead_code)] // agents #2/#3 land in parallel after this PR merges
pub async fn eval_and_await<R: Runtime>(
    app: &AppHandle<R>,
    window_label: &str,
    js_template: &str,
    payload: Value,
    timeout: std::time::Duration,
) -> Result<Value, crate::error::Error> {
    let correlation_id = Uuid::new_v4().to_string();

    let payload_json = serde_json::to_string(&payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Failed to serialize eval payload: {}", e))
    })?;
    let cid_literal = serde_json::to_string(&correlation_id).map_err(|e| {
        crate::error::Error::Anyhow(format!("Failed to serialize correlation_id: {}", e))
    })?;

    let rendered = js_template
        .replace("{{correlationId}}", &cid_literal)
        .replace("{{payload}}", &payload_json);

    let webview = app.get_webview_window(window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!(
            "Webview window not found: {} (eval_and_await requires a top-level WebviewWindow)",
            window_label
        ))
    })?;

    // Register BEFORE eval so the response can never race ahead of registration.
    let rx = PendingResults::register(correlation_id.clone());

    log::info!(
        "[TAURI_MCP] eval_and_await dispatching: cid={} window={} js_len={}",
        correlation_id,
        window_label,
        rendered.len()
    );

    if let Err(e) = webview.eval(&rendered) {
        PendingResults::cancel(&correlation_id);
        log::error!(
            "[TAURI_MCP] webview.eval failed: cid={} err={}",
            correlation_id,
            e
        );
        return Err(crate::error::Error::Anyhow(format!(
            "Failed to eval JS in webview {}: {}",
            window_label, e
        )));
    }

    log::info!(
        "[TAURI_MCP] eval_and_await: webview.eval succeeded, awaiting cid={}",
        correlation_id
    );

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => {
            PendingResults::cancel(&correlation_id);
            Err(crate::error::Error::Anyhow("Sender dropped".to_string()))
        }
        Err(_) => {
            PendingResults::cancel(&correlation_id);
            Err(crate::error::Error::Anyhow(format!(
                "Timeout waiting for {} response (eval-based)",
                correlation_id
            )))
        }
    }
}

// ---- Correlation-ID based emit+wait helper ----

/// Emit an event to a webview and wait for a correlated response.
///
/// 1. Generates a UUID correlation ID.
/// 2. Injects `_correlationId` into the JSON payload sent to JS.
/// 3. Registers a one-shot listener on `"{response_event}-{uuid}"` BEFORE emitting.
/// 4. Emits `request_event` with the augmented payload.
/// 5. Awaits up to `timeout` for the JS side to respond on the correlated event.
/// 6. Returns the raw payload string, or an error on timeout / emit failure.
pub async fn emit_and_wait<R: Runtime>(
    app: &AppHandle<R>,
    emit_target: &str,
    request_event: &str,
    response_event: &str,
    mut payload: Value,
    timeout: std::time::Duration,
) -> Result<String, crate::error::Error> {
    let correlation_id = Uuid::new_v4().to_string();

    // Inject the correlation ID into the payload
    if let Some(obj) = payload.as_object_mut() {
        obj.insert(
            "_correlationId".to_string(),
            Value::String(correlation_id.clone()),
        );
    } else {
        // If payload isn't an object, wrap it
        payload = serde_json::json!({
            "_payload": payload,
            "_correlationId": correlation_id.clone(),
        });
    }

    let (tx, rx) = tokio::sync::oneshot::channel();

    // Register correlated listener BEFORE emitting (avoids race condition)
    let correlated_event = format!("{}-{}", response_event, correlation_id);
    let listener_id = app.once(correlated_event, move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    // Emit the request
    if let Err(e) = app.emit_to(emit_target, request_event, payload) {
        app.unlisten(listener_id);
        return Err(crate::error::Error::Anyhow(format!(
            "Failed to emit {} event: {}",
            request_event, e
        )));
    }

    // Await the correlated response with timeout
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(payload)) => {
            // once() auto-unlistens after firing, but we must also unlisten
            // explicitly to prevent the EventId Drop impl from double-unlistening
            app.unlisten(listener_id);
            Ok(payload)
        }
        Ok(Err(_)) => {
            app.unlisten(listener_id);
            // Sender dropped without sending (listener was cleaned up)
            Err(crate::error::Error::Anyhow(format!(
                "Listener dropped before {} response received",
                request_event
            )))
        }
        Err(_) => {
            app.unlisten(listener_id);
            Err(crate::error::Error::Anyhow(format!(
                "Timeout waiting for {} response",
                request_event
            )))
        }
    }
}

// ---- Parse / extract helpers ----

/// Parse a JSON response string from the JS side into a SocketResponse.
/// Handles double-encoded JSON from the Tauri event system.
pub fn parse_js_response(result_string: &str) -> crate::socket_server::SocketResponse {
    let data: Value = serde_json::from_str(result_string)
        .unwrap_or_else(|_| Value::String(result_string.to_string()));

    // If data is a string (double-encoded), parse it again
    let data = if let Some(s) = data.as_str() {
        serde_json::from_str(s).unwrap_or(Value::String(s.to_string()))
    } else {
        data
    };

    let success = data
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if success {
        crate::socket_server::SocketResponse {
            success: true,
            data: data.get("data").cloned(),
            error: None,
            id: None,
        }
    } else {
        crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(
                data.get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error")
                    .to_string(),
            ),
            id: None,
        }
    }
}

/// Extract window_label from various payload formats (string or object).
fn extract_window_label(payload: &Value) -> Result<String, crate::error::Error> {
    if payload.is_string() {
        payload
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| crate::error::Error::Anyhow("Invalid string payload".to_string()))
    } else if payload.is_object() {
        payload
            .get("window_label")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                crate::error::Error::Anyhow(
                    "Missing or invalid window_label in payload".to_string(),
                )
            })
    } else {
        Err(crate::error::Error::Anyhow(format!(
            "Invalid payload format: expected string or object with window_label, got {}",
            payload
        )))
    }
}

// ---- Command handlers ----

pub async fn handle_get_dom<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;

    let timeout_secs = payload
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(10);

    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    // JS body lifted from getDomContent in guest-js/index.ts.
    let js_template = r#"
(async () => {
  try {
    let dom = '';
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      dom = document.documentElement.outerHTML;
    }
    if (!dom) {
      throw new Error('Retrieved DOM string is empty');
    }
    await window.__TAURI_INTERNALS__.invoke('mcp_result'|'mcp_result', {
      correlationId: {{correlationId}},
      ok: true,
      data: dom,
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
        std::time::Duration::from_secs(timeout_secs),
    )
    .await
    {
        Ok(envelope) => Ok(parse_envelope(envelope)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("eval_and_await failed for get_dom: {}", e)),
            id: None,
        }),
    }
}

/// JS body for `get_page_map` — full DOM walk with numbered refs, content
/// extraction, delta tracking, and metadata. Populates
/// `window.__mcpPageMapRefs` so other handlers (wait_for, scroll_page,
/// get_element_position, send_text_to_element, fill_form) can resolve refs.
/// Mirrors the getPageMap() function in guest-js/index.ts. Delta state
/// (`__mcpPrevFingerprints`, `__mcpPrevMaxRef`) lives on `window` so it
/// survives across calls.
const GET_PAGE_MAP_JS: &str = r#"
(async () => {
  const NOISE_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','LINK','META','HEAD','BR','HR','IFRAME','OBJECT','EMBED','TEMPLATE','SLOT']);
  const INTERACTIVE_TAGS = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','DETAILS','SUMMARY']);
  const INTERACTIVE_ROLES = new Set(['button','link','textbox','checkbox','radio','switch','slider','spinbutton','combobox','listbox','option','menuitem','tab','searchbox']);
  const SEMANTIC_TAGS = new Set(['H1','H2','H3','H4','H5','H6','IMG','NAV','MAIN','HEADER','FOOTER','ASIDE','SECTION','ARTICLE','FIGURE','FIGCAPTION','TABLE','FORM','LABEL','FIELDSET','LEGEND','P','LI','OL','UL','DL','DT','DD']);
  const CONTEXT_TAGS = new Set(['NAV','MAIN','HEADER','FOOTER','ASIDE','SECTION','ARTICLE','FORM','DIALOG','DETAILS','FIELDSET','FIGURE','TABLE']);
  const LANDMARK_ROLES = { navigation: 'nav', main: 'main', banner: 'header', contentinfo: 'footer', complementary: 'aside', search: 'search', form: 'form', region: 'region', dialog: 'dialog' };
  const SECONDARY_CONTEXT_TAGS = new Set(['NAV','FOOTER','ASIDE','HEADER']);

  const isElementVisible = (el) => {
    if (!(el instanceof HTMLElement)) return true;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hidden) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    if (style.overflow === 'hidden' && (rect.width <= 1 || rect.height <= 1)) return false;
    const position = style.position;
    if (position === 'absolute' || position === 'fixed') {
      const left = parseFloat(style.left);
      const top = parseFloat(style.top);
      if ((!isNaN(left) && left <= -9000) || (!isNaN(top) && top <= -9000)) return false;
    }
    return true;
  };
  const isInteractive = (el) => {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    if (el.getAttribute('tabindex') !== null && el.getAttribute('tabindex') !== '-1') return true;
    if (el.getAttribute('onclick') || el.getAttribute('ng-click') || el.getAttribute('@click')) return true;
    const trackedSet = window.__TAURI_MCP_ELEMENTS_WITH_LISTENERS__;
    if (trackedSet && trackedSet.has(el)) return true;
    return false;
  };
  const isSemanticElement = (el) => {
    if (SEMANTIC_TAGS.has(el.tagName)) return true;
    if (el.getAttribute('role')) return true;
    if (el.getAttribute('aria-label')) return true;
    if (el.getAttribute('data-testid') || el.id) return true;
    return false;
  };
  const isContextElement = (el) => {
    if (CONTEXT_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    return !!(role && LANDMARK_ROLES[role]);
  };
  const buildContextLabel = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    let label = role && LANDMARK_ROLES[role] ? '[role=' + role + ']' : tag;
    if (el.id) label += '#' + el.id;
    else {
      const cls = el.className;
      if (typeof cls === 'string' && cls.trim()) label += '.' + cls.trim().split(/\s+/)[0];
    }
    return label;
  };
  const getElementText = (el) => {
    if (el instanceof HTMLInputElement) return el.value || el.placeholder || '';
    if (el instanceof HTMLTextAreaElement) return el.value || el.placeholder || '';
    if (el instanceof HTMLSelectElement) {
      const opt = el.options[el.selectedIndex];
      return opt ? opt.text : '';
    }
    let text = '';
    if (el instanceof HTMLElement) text = (el.innerText || '').trim();
    if (!text) text = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (text.length > 100) text = text.substring(0, 97) + '...';
    return text;
  };
  const elementFingerprint = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id || '';
    const name = el.name || '';
    const type = el.type || '';
    const href = el.href || '';
    const text50 = (el.textContent || '').trim().substring(0, 50);
    const class50 = (typeof el.className === 'string' ? el.className : '').substring(0, 50);
    let nthChild = 0;
    if (el.parentElement) {
      const siblings = el.parentElement.children;
      for (let i = 0; i < siblings.length; i++) { if (siblings[i] === el) { nthChild = i; break; } }
    }
    return tag + '|' + id + '|' + name + '|' + type + '|' + href + '|' + text50 + '|' + class50 + '|' + nthChild;
  };
  const buildPageMapEntry = (el, interactiveOnly) => {
    const interactive = isInteractive(el);
    if (!interactive && (interactiveOnly || !isSemanticElement(el))) return null;
    const entry = { ref: 0, tag: el.tagName.toLowerCase() };
    if (!interactive) entry.interactive = false;
    if (el instanceof HTMLInputElement) {
      entry.type = el.type;
      if (el.value) entry.value = el.value.substring(0, 100);
      if (el.placeholder) entry.placeholder = el.placeholder;
      if (el.name) entry.name = el.name;
      if (el.type === 'checkbox' || el.type === 'radio') entry.checked = el.checked;
      if (el.disabled) entry.disabled = true;
    } else if (el instanceof HTMLTextAreaElement) {
      entry.type = 'textarea';
      if (el.value) entry.value = el.value.substring(0, 100);
      if (el.placeholder) entry.placeholder = el.placeholder;
      if (el.name) entry.name = el.name;
      if (el.disabled) entry.disabled = true;
    } else if (el instanceof HTMLSelectElement) {
      entry.type = 'select';
      entry.options = Array.from(el.options).map(o => o.text).slice(0, 10);
      if (el.name) entry.name = el.name;
      if (el.disabled) entry.disabled = true;
    } else if (el instanceof HTMLAnchorElement) {
      entry.href = el.href;
    } else if (el instanceof HTMLImageElement) {
      if (el.alt) entry.text = el.alt;
    }
    const text = getElementText(el);
    if (text) entry.text = text;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel !== text) entry.ariaLabel = ariaLabel;
    const role = el.getAttribute('role');
    if (role) entry.role = role;
    if (el.id) entry.id = el.id;
    return entry;
  };
  const extractPageMetadata = () => {
    const metadata = {};
    const descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) {
      const c = descMeta.getAttribute('content');
      if (c) metadata.description = c;
    }
    const ogTags = document.querySelectorAll('meta[property^="og:"]');
    if (ogTags.length > 0) {
      const og = {};
      ogTags.forEach(t => {
        const p = t.getAttribute('property');
        const c = t.getAttribute('content');
        if (p && c) og[p] = c;
      });
      if (Object.keys(og).length > 0) metadata.openGraph = og;
    }
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    if (jsonLdScripts.length > 0) {
      const arr = [];
      jsonLdScripts.forEach(s => {
        try { arr.push(JSON.parse(s.textContent || '')); } catch (_) {}
      });
      if (arr.length > 0) metadata.jsonLd = arr;
    }
    return metadata;
  };
  const waitForDomStable = (quietMs, maxWaitMs) => new Promise((resolve) => {
    let resolved = false;
    let timer;
    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearTimeout(timeout);
      observer.disconnect();
      resolve();
    };
    const timeout = setTimeout(done, maxWaitMs);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    timer = setTimeout(done, quietMs);
  });

  try {
    const options = {{payload}};
    if (options.waitForStable) {
      const quietMs = typeof options.quietMs === 'number' ? options.quietMs : 300;
      const maxWaitMs = typeof options.maxWaitMs === 'number' ? options.maxWaitMs : 3000;
      await waitForDomStable(quietMs, maxWaitMs);
    }

    const interactiveOnly = options.interactiveOnly === true;
    const includeContent = interactiveOnly ? false : (options.includeContent !== false);
    const includeMetadata = options.includeMetadata !== false;
    const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : Infinity;
    const isDelta = options.delta === true;
    const scopeSelector = options.scopeSelector;

    // Page-map ref state — exposed on window so other handlers can resolve refs.
    if (!window.__mcpPageMapRefs || typeof window.__mcpPageMapRefs.clear !== 'function') {
      window.__mcpPageMapRefs = new Map();
    }
    const refMap = window.__mcpPageMapRefs;
    refMap.clear();

    // Delta state — survives across calls.
    if (!(window.__mcpPrevFingerprints instanceof Map)) window.__mcpPrevFingerprints = new Map();
    if (typeof window.__mcpPrevMaxRef !== 'number') window.__mcpPrevMaxRef = 0;

    const elements = [];
    let refCounter = isDelta ? window.__mcpPrevMaxRef + 1 : 1;
    const seenTexts = new Set();
    const mainContentParts = [];
    const secondaryContentParts = [];
    const currentFingerprints = new Map();

    const assignRef = (el, entry) => {
      if (isDelta) {
        const fp = elementFingerprint(el);
        const prev = window.__mcpPrevFingerprints.get(fp);
        if (prev) {
          entry.ref = prev.ref;
          refMap.set(prev.ref, el);
          currentFingerprints.set(fp, { ref: prev.ref, props: entry });
          return prev.ref;
        }
      }
      const ref = refCounter++;
      entry.ref = ref;
      refMap.set(ref, el);
      if (isDelta) currentFingerprints.set(elementFingerprint(el), { ref, props: entry });
      return ref;
    };

    const isSecondaryContext = (contextStack) => {
      for (const ctx of contextStack) {
        for (const tag of SECONDARY_CONTEXT_TAGS) {
          if (ctx.toLowerCase().startsWith(tag.toLowerCase()) || ctx.startsWith('[role=' + tag.toLowerCase())) return true;
        }
      }
      return false;
    };

    let nodesVisited = 0;
    const walkNode = (node, depth, contextStack, parentRefNum, hiddenAncestor = false) => {
      nodesVisited++;
      if (depth > maxDepth) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (interactiveOnly) return;
        if (hiddenAncestor) return;
        const text = (node.textContent || '').trim();
        if (includeContent && text && !seenTexts.has(text)) {
          seenTexts.add(text);
          if (isSecondaryContext(contextStack)) secondaryContentParts.push(text);
          else mainContentParts.push(text);
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      if (NOISE_TAGS.has(el.tagName)) return;
      const tagUpper = el.tagName.toUpperCase();
      const isSvgNs = el.namespaceURI === 'http://www.w3.org/2000/svg';
      if (tagUpper === 'SVG' || (isSvgNs && tagUpper !== 'SVG')) {
        if (tagUpper === 'SVG') {
          const label = el.getAttribute('aria-label');
          if (label && isElementVisible(el)) {
            const entry = { ref: 0, tag: 'svg', ariaLabel: label, depth };
            if (contextStack.length > 0) entry.context = contextStack.join(' > ');
            if (parentRefNum !== null) entry.parentRef = parentRefNum;
            assignRef(el, entry);
            elements.push(entry);
          }
        }
        return;
      }
      let newContextStack = contextStack;
      if (isContextElement(el)) newContextStack = contextStack.concat([buildContextLabel(el)]);
      const selfVisible = isElementVisible(el);
      const isHidden = hiddenAncestor || !selfVisible;
      let currentParentRef = parentRefNum;
      if (selfVisible && !hiddenAncestor) {
        const entry = buildPageMapEntry(el, interactiveOnly);
        if (entry) {
          entry.depth = depth;
          if (newContextStack.length > 0) entry.context = newContextStack.join(' > ');
          if (parentRefNum !== null) entry.parentRef = parentRefNum;
          assignRef(el, entry);
          elements.push(entry);
          currentParentRef = entry.ref;
        }
      } else {
        const entry = buildPageMapEntry(el, interactiveOnly);
        if (entry) {
          entry.depth = depth;
          entry.visible = false;
          if (newContextStack.length > 0) entry.context = newContextStack.join(' > ');
          if (parentRefNum !== null) entry.parentRef = parentRefNum;
          assignRef(el, entry);
          elements.push(entry);
          currentParentRef = entry.ref;
        }
      }
      for (const child of el.childNodes) walkNode(child, depth + 1, newContextStack, currentParentRef, isHidden);
    };

    const roots = [];
    if (scopeSelector) {
      const selectors = Array.isArray(scopeSelector) ? scopeSelector : [scopeSelector];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) roots.push(el);
      }
    }
    if (roots.length === 0) roots.push(document.body || document.documentElement);
    for (const root of roots) walkNode(root, 0, [], null);

    if (elements.length === 0 && nodesVisited < 5) {
      const allEls = document.querySelectorAll('body *');
      for (const el of allEls) {
        if (NOISE_TAGS.has(el.tagName)) continue;
        if (el.namespaceURI === 'http://www.w3.org/2000/svg') continue;
        if (!isElementVisible(el)) continue;
        const entry = buildPageMapEntry(el, interactiveOnly);
        if (entry) {
          const ctxParts = [];
          let ancestor = el.parentElement;
          while (ancestor && ancestor !== document.body) {
            if (isContextElement(ancestor)) ctxParts.unshift(buildContextLabel(ancestor));
            ancestor = ancestor.parentElement;
          }
          if (ctxParts.length > 0) entry.context = ctxParts.join(' > ');
          assignRef(el, entry);
          elements.push(entry);
        }
        if (!interactiveOnly && includeContent) {
          for (const child of el.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              const text = (child.textContent || '').trim();
              if (text && !seenTexts.has(text)) {
                seenTexts.add(text);
                mainContentParts.push(text);
              }
            }
          }
        }
      }
    }

    let deltaResult;
    if (isDelta) {
      const added = [];
      const removed = [];
      const changed = [];
      for (const [fp, cur] of currentFingerprints) {
        const prev = window.__mcpPrevFingerprints.get(fp);
        if (!prev) added.push(cur.ref);
        else {
          const curClone = Object.assign({}, cur.props, { ref: 0 });
          const prevClone = Object.assign({}, prev.props, { ref: 0 });
          if (JSON.stringify(curClone) !== JSON.stringify(prevClone)) changed.push(cur.ref);
        }
      }
      for (const [fp, prev] of window.__mcpPrevFingerprints) {
        if (!currentFingerprints.has(fp)) removed.push(prev.ref);
      }
      deltaResult = { added, removed, changed };
      window.__mcpPrevFingerprints = currentFingerprints;
      window.__mcpPrevMaxRef = Math.max(refCounter - 1, ...elements.map(e => e.ref || 0));
    } else {
      window.__mcpPrevFingerprints = new Map();
      window.__mcpPrevMaxRef = 0;
    }

    let content = '';
    if (includeContent) {
      const mainText = mainContentParts.join(' ').replace(/\s+/g, ' ').trim();
      const secondaryText = secondaryContentParts.join(' ').replace(/\s+/g, ' ').trim();
      const CONTENT_BUDGET = 5000;
      if (mainText.length >= CONTENT_BUDGET) {
        content = mainText.substring(0, CONTENT_BUDGET - 3) + '...';
      } else {
        content = mainText;
        const remaining = CONTENT_BUDGET - content.length;
        if (remaining > 10 && secondaryText) {
          const sep = content ? ' ' : '';
          if (secondaryText.length <= remaining - sep.length) {
            content += sep + secondaryText;
          } else {
            content += sep + secondaryText.substring(0, remaining - sep.length - 3) + '...';
          }
        }
      }
    }

    const result = {
      url: window.location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      elements,
      content,
    };
    if (includeMetadata) {
      const metadata = extractPageMetadata();
      if (metadata.description || metadata.openGraph || metadata.jsonLd) result.metadata = metadata;
    }
    if (scopeSelector) result.scope = scopeSelector;
    if (typeof options.maxDepth === 'number') result.maxDepth = options.maxDepth;
    if (deltaResult) result.delta = deltaResult;

    await window.__TAURI_INTERNALS__.invoke('mcp_result'|'mcp_result', {
      correlationId: {{correlationId}},
      ok: true,
      data: result,
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

/// Handler for get_page_map — returns a structured page map with numbered element refs
pub async fn handle_get_page_map<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;

    let timeout_secs = payload
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(10);

    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let js_payload = serde_json::json!({
        "includeContent": payload.get("include_content").and_then(|v| v.as_bool()).unwrap_or(true),
        "waitForStable": payload.get("wait_for_stable").and_then(|v| v.as_bool()).unwrap_or(false),
        "quietMs": payload.get("quiet_ms").and_then(|v| v.as_u64()).unwrap_or(300),
        "maxWaitMs": payload.get("max_wait_ms").and_then(|v| v.as_u64()).unwrap_or(3000),
        "interactiveOnly": payload.get("interactive_only").and_then(|v| v.as_bool()).unwrap_or(false),
        "scopeSelector": payload.get("scope_selector"),
        "maxDepth": payload.get("max_depth").and_then(|v| v.as_u64()),
        "delta": payload.get("delta").and_then(|v| v.as_bool()).unwrap_or(false),
        "includeMetadata": payload.get("include_metadata").and_then(|v| v.as_bool()).unwrap_or(true)
    });

    match eval_and_await(
        app,
        &window_label,
        GET_PAGE_MAP_JS,
        js_payload,
        std::time::Duration::from_secs(timeout_secs),
    )
    .await
    {
        Ok(envelope) => Ok(parse_envelope(envelope)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("eval_and_await failed for get_page_map: {}", e)),
            id: None,
        }),
    }
}

#[derive(Debug, Deserialize)]
struct GetElementPositionPayload {
    window_label: String,
    selector_type: String,
    selector_value: String,
    #[serde(default)]
    should_click: bool,
    #[serde(default)]
    raw_coordinates: bool,
}

pub async fn handle_get_element_position<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let parsed = serde_json::from_value::<GetElementPositionPayload>(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for get_element_position: {}", e))
    })?;

    let js_payload = serde_json::json!({
        "windowLabel": parsed.window_label,
        "selectorType": parsed.selector_type,
        "selectorValue": parsed.selector_value,
        "shouldClick": parsed.should_click,
        "rawCoordinates": parsed.raw_coordinates
    });

    // JS body lifted from handleGetElementPositionRequest in guest-js/index.ts.
    // Inlines findElementByText, getElementByRef (window.__mcpPageMapRefs lookup),
    // clickElement, and isTypeable so the script is self-contained.
    let js_template = r#"
(async () => {
  const isTypeable = (el) => {
    const tag = el && el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    if (el && el.hasAttribute && (el.hasAttribute('data-lexical-editor') || el.hasAttribute('data-slate-editor'))) return true;
    if (el && el.closest && (el.closest('[data-lexical-editor]') || el.closest('[data-slate-editor]'))) return true;
    return false;
  };
  const findElementByText = (text) => {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.textContent && el.textContent.trim() === text) return el;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.placeholder === text) return el;
      }
      if (el.getAttribute('title') === text) return el;
      if (el.getAttribute('aria-label') === text) return el;
    }
    for (const el of all) {
      if (el.textContent && el.textContent.trim().includes(text)) return el;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.placeholder && el.placeholder.includes(text)) return el;
      }
      const title = el.getAttribute('title');
      if (title && title.includes(text)) return el;
      const aria = el.getAttribute('aria-label');
      if (aria && aria.includes(text)) return el;
    }
    return null;
  };
  const getElementByRef = (ref) => {
    const map = window.__mcpPageMapRefs;
    if (map && typeof map.get === 'function') return map.get(ref) || null;
    return null;
  };
  const clickElement = (element, centerX, centerY) => {
    try {
      if (element instanceof HTMLElement) element.focus();
      if (isTypeable(element)) window.__mcpLastFocusedElement = element;
      const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: centerX, clientY: centerY });
      const mu = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: centerX, clientY: centerY });
      element.dispatchEvent(md);
      element.dispatchEvent(mu);
      if (element instanceof HTMLElement && typeof element.click === 'function') {
        element.click();
        return { success: true, elementTag: element.tagName, position: { x: centerX, y: centerY }, method: 'native-click' };
      }
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: centerX, clientY: centerY });
      element.dispatchEvent(click);
      return { success: true, elementTag: element.tagName, position: { x: centerX, y: centerY }, method: 'dispatch-event' };
    } catch (e) {
      return { success: false, error: String(e && e.message ? e.message : e) };
    }
  };
  try {
    const payload = {{payload}};
    const selectorType = payload.selectorType;
    const selectorValue = payload.selectorValue;
    const shouldClick = payload.shouldClick === true;
    let element = null;
    let debug = [];
    switch (selectorType) {
      case 'ref': {
        const refNum = parseInt(selectorValue, 10);
        element = getElementByRef(refNum);
        if (!element) debug.push('No element found with ref=' + refNum + '. Call get_page_map first to populate refs.');
        break;
      }
      case 'id':
        element = document.getElementById(selectorValue);
        break;
      case 'class': {
        const els = document.getElementsByClassName(selectorValue);
        element = els.length > 0 ? els[0] : null;
        break;
      }
      case 'tag': {
        const els = document.getElementsByTagName(selectorValue);
        element = els.length > 0 ? els[0] : null;
        break;
      }
      case 'text':
        element = findElementByText(selectorValue);
        break;
      default:
        throw new Error('Unsupported selector type: ' + selectorType);
    }
    if (!element) {
      throw new Error('Element with ' + selectorType + '="' + selectorValue + '" not found. ' + debug.join(' '));
    }
    const rect = element.getBoundingClientRect();
    const elementViewportCssX = rect.left + (rect.width / 2);
    const elementViewportCssY = rect.top + (rect.height / 2);
    const elementDocumentCssX = elementViewportCssX + window.scrollX;
    const elementDocumentCssY = elementViewportCssY + window.scrollY;
    const targetX = elementDocumentCssX;
    const targetY = elementDocumentCssY;
    let clickResult = null;
    if (shouldClick) clickResult = clickElement(element, elementViewportCssX, elementViewportCssY);
    const data = {
      x: targetX,
      y: targetY,
      element: {
        tag: element.tagName,
        classes: element.className,
        id: element.id,
        text: (element.textContent || '').trim(),
        placeholder: element instanceof HTMLInputElement ? element.placeholder : undefined
      },
      clicked: shouldClick,
      clickResult,
      debug: {
        elementRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        viewportCenter: { x: elementViewportCssX, y: elementViewportCssY },
        documentCenter: { x: elementDocumentCssX, y: elementDocumentCssY },
        window: {
          innerSize: { width: window.innerWidth, height: window.innerHeight },
          scrollPosition: { x: window.scrollX, y: window.scrollY }
        }
      }
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
        &parsed.window_label,
        js_template,
        js_payload,
        std::time::Duration::from_secs(5),
    )
    .await
    {
        Ok(envelope) => Ok(parse_envelope(envelope)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!(
                "eval_and_await failed for get_element_position: {}",
                e
            )),
            id: None,
        }),
    }
}

#[derive(Debug, Deserialize)]
struct SendTextToElementPayload {
    window_label: String,
    selector_type: String,
    selector_value: String,
    text: String,
    #[serde(default = "default_delay_ms")]
    delay_ms: u32,
}

fn default_delay_ms() -> u32 {
    20
}

pub async fn handle_send_text_to_element<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let parsed = serde_json::from_value::<SendTextToElementPayload>(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for send_text_to_element: {}", e))
    })?;

    let js_payload = serde_json::json!({
        "selectorType": parsed.selector_type,
        "selectorValue": parsed.selector_value,
        "text": parsed.text,
        "delayMs": parsed.delay_ms
    });

    // JS body lifted from handleSendTextToElementRequest in guest-js/index.ts.
    // Inlines selectors + the four typing strategies (simulateReactInputTyping,
    // typeIntoContentEditable, typeIntoLexicalEditor, typeIntoSlateEditor) so
    // the eval'd code stands alone.
    let js_template = r#"
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const findElementByText = (text) => {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.textContent && el.textContent.trim() === text) return el;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.placeholder === text) return el;
      }
      if (el.getAttribute('title') === text) return el;
      if (el.getAttribute('aria-label') === text) return el;
    }
    for (const el of all) {
      if (el.textContent && el.textContent.trim().includes(text)) return el;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.placeholder && el.placeholder.includes(text)) return el;
      }
      const title = el.getAttribute('title');
      if (title && title.includes(text)) return el;
      const aria = el.getAttribute('aria-label');
      if (aria && aria.includes(text)) return el;
    }
    return null;
  };
  const getElementByRef = (ref) => {
    const map = window.__mcpPageMapRefs;
    if (map && typeof map.get === 'function') return map.get(ref) || null;
    return null;
  };
  const simulateReactInputTyping = async (element, text, delayMs, clear = true) => {
    element.focus();
    await sleep(50);
    try {
      if (clear) {
        element.select();
        document.execCommand('delete', false);
        await sleep(50);
      }
      if (delayMs > 0) {
        for (let i = 0; i < text.length; i++) {
          document.execCommand('insertText', false, text[i]);
          if (i < text.length - 1) await sleep(delayMs);
        }
      } else {
        document.execCommand('insertText', false, text);
      }
    } catch (e) {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(element, text); else element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  const typeIntoContentEditable = async (element, text, delayMs) => {
    element.focus();
    await sleep(50);
    element.innerHTML = '';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    await sleep(50);
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: char, code: 'Key' + char.toUpperCase() }));
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection && selection.removeAllRanges();
      selection && selection.addRange(range);
      const node = document.createTextNode(char);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      selection && selection.removeAllRanges();
      selection && selection.addRange(range);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char }));
      element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: char, code: 'Key' + char.toUpperCase() }));
      if (delayMs > 0 && i < text.length - 1) await sleep(delayMs);
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const typeIntoLexicalEditor = async (element, text, delayMs) => {
    element.focus();
    await sleep(100);
    const paragraphs = element.querySelectorAll('p');
    if (paragraphs.length > 0) {
      for (const p of paragraphs) p.innerHTML = '<br>';
    } else {
      element.innerHTML = '<p class="editor-paragraph"><br></p>';
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    await sleep(100);
    const targetParagraph = element.querySelector('p') || element;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const active = document.activeElement;
      const target = (active && element.contains(active)) ? active : targetParagraph;
      const beforeInput = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: char });
      target.dispatchEvent(beforeInput);
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: char, code: 'Key' + char.toUpperCase(), composed: true }));
      if (!beforeInput.defaultPrevented) document.execCommand('insertText', false, char);
      target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char }));
      target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: char, code: 'Key' + char.toUpperCase(), composed: true }));
      if (delayMs > 0 && i < text.length - 1) await sleep(delayMs);
    }
  };
  const typeIntoSlateEditor = async (element, text, delayMs) => {
    element.focus();
    await sleep(100);
    const editable = element.querySelector('[contenteditable="true"]') || element;
    if (editable instanceof HTMLElement) editable.focus();
    document.execCommand('selectAll', false, undefined);
    document.execCommand('delete', false, undefined);
    await sleep(50);
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const active = document.activeElement || editable;
      active.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: char }));
      document.execCommand('insertText', false, char);
      active.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char }));
      active.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: char }));
      if (delayMs > 0 && i < text.length - 1) await sleep(delayMs);
    }
  };
  try {
    const payload = {{payload}};
    const selectorType = payload.selectorType;
    const selectorValue = payload.selectorValue;
    const text = payload.text;
    const delayMs = typeof payload.delayMs === 'number' ? payload.delayMs : 20;
    let element = null;
    let debug = [];
    switch (selectorType) {
      case 'ref': {
        const refNum = parseInt(selectorValue, 10);
        element = getElementByRef(refNum);
        if (!element) debug.push('No element found with ref=' + refNum + '. Call get_page_map first to populate refs.');
        break;
      }
      case 'id': element = document.getElementById(selectorValue); break;
      case 'class': {
        const els = document.getElementsByClassName(selectorValue);
        element = els.length > 0 ? els[0] : null;
        break;
      }
      case 'tag': {
        const els = document.getElementsByTagName(selectorValue);
        element = els.length > 0 ? els[0] : null;
        break;
      }
      case 'text': element = findElementByText(selectorValue); break;
      default: throw new Error('Unsupported selector type: ' + selectorType);
    }
    if (!element) throw new Error('Element with ' + selectorType + '="' + selectorValue + '" not found. ' + debug.join(' '));
    const isEditable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable;
    if (element instanceof HTMLElement) element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      await simulateReactInputTyping(element, text, delayMs);
    } else if (element.isContentEditable) {
      const isLexical = element.hasAttribute('data-lexical-editor');
      const isSlate = element.hasAttribute('data-slate-editor') || element.querySelector('[data-slate-editor="true"]') !== null;
      if (isLexical) await typeIntoLexicalEditor(element, text, delayMs);
      else if (isSlate) await typeIntoSlateEditor(element, text, delayMs);
      else await typeIntoContentEditable(element, text, delayMs);
    } else {
      element.textContent = text;
    }
    const data = {
      element: {
        tag: element.tagName,
        classes: element.className,
        id: element.id,
        type: element instanceof HTMLInputElement ? element.type : null,
        text,
        isEditable
      }
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
        &parsed.window_label,
        js_template,
        js_payload,
        std::time::Duration::from_secs(30),
    )
    .await
    {
        Ok(envelope) => Ok(parse_envelope(envelope)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!(
                "eval_and_await failed for send_text_to_element: {}",
                e
            )),
            id: None,
        }),
    }
}

/// Parse an eval_and_await envelope `{ok, data, error}` into a SocketResponse.
pub fn parse_envelope(envelope: Value) -> crate::socket_server::SocketResponse {
    let ok = envelope
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if ok {
        crate::socket_server::SocketResponse {
            success: true,
            data: envelope.get("data").cloned(),
            error: None,
            id: None,
        }
    } else {
        let error_msg = envelope
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error from JS")
            .to_string();
        crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(error_msg),
            id: None,
        }
    }
}

/// Handler for get_page_state — lightweight URL/title/readyState check
pub async fn handle_get_page_state<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    // JS body lifted from handleGetPageStateRequest in guest-js/index.ts.
    // Wrapped in IIFE that calls plugin:mcp|mcp_result on resolve/throw.
    let js_template = r#"
(async () => {
  try {
    const data = {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      scrollPosition: { x: window.scrollX, y: window.scrollY },
      viewport: { width: window.innerWidth, height: window.innerHeight }
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
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("eval_and_await failed for get_page_state: {}", e)),
            id: None,
        }),
    }
}

/// Handler for navigate_back — browser history back/forward/go(n)
pub async fn handle_navigate_back<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let js_payload = serde_json::json!({
        "direction": payload.get("direction").and_then(|v| v.as_str()).unwrap_or("back"),
        "delta": payload.get("delta").and_then(|v| v.as_i64())
    });

    // JS body lifted from handleNavigateBackRequest in guest-js/index.ts.
    let js_template = r#"
(async () => {
  try {
    const payload = {{payload}};
    const direction = payload.direction;
    const delta = payload.delta;
    if (typeof delta === 'number') {
      history.go(delta);
    } else if (direction === 'forward') {
      history.forward();
    } else {
      history.back();
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    const data = {
      url: window.location.href,
      title: document.title
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
        js_payload,
        std::time::Duration::from_secs(5),
    )
    .await
    {
        Ok(envelope) => Ok(parse_envelope(envelope)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("eval_and_await failed for navigate_back: {}", e)),
            id: None,
        }),
    }
}

/// Handler for scroll_page — scroll by page/half/pixels, to element ref, or to top/bottom
pub async fn handle_scroll_page<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let js_payload = serde_json::json!({
        "direction": payload.get("direction").and_then(|v| v.as_str()),
        "amount": payload.get("amount"),
        "toRef": payload.get("to_ref").and_then(|v| v.as_i64()),
        "toTop": payload.get("to_top").and_then(|v| v.as_bool()).unwrap_or(false),
        "toBottom": payload.get("to_bottom").and_then(|v| v.as_bool()).unwrap_or(false)
    });

    // JS body lifted from handleScrollPageRequest in guest-js/index.ts.
    // getElementByRef pulls from window.__mcpPageMapRefs (populated by get_page_map).
    let js_template = r#"
(async () => {
  const getElementByRef = (ref) => {
    const map = window.__mcpPageMapRefs;
    if (map && typeof map.get === 'function') return map.get(ref) || null;
    return null;
  };
  try {
    const payload = {{payload}};
    const direction = payload.direction;
    const amount = payload.amount;
    const toRef = payload.toRef;
    const toTop = payload.toTop;
    const toBottom = payload.toBottom;
    if (toTop) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (toBottom) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    } else if (typeof toRef === 'number') {
      const el = getElementByRef(toRef);
      if (!el) throw new Error('No element found with ref=' + toRef + '. Call get_page_map first.');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      const vh = window.innerHeight;
      let pixels;
      if (typeof amount === 'number') pixels = amount;
      else if (amount === 'half') pixels = Math.round(vh / 2);
      else pixels = vh;
      if (direction === 'up') pixels = -pixels;
      window.scrollBy({ top: pixels, behavior: 'smooth' });
    }
    await new Promise((r) => setTimeout(r, 350));
    const data = {
      scrollPosition: { x: window.scrollX, y: window.scrollY },
      pageHeight: document.documentElement.scrollHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight }
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
        js_payload,
        std::time::Duration::from_secs(5),
    )
    .await
    {
        Ok(envelope) => Ok(parse_envelope(envelope)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("eval_and_await failed for scroll_page: {}", e)),
            id: None,
        }),
    }
}

/// Handler for fill_form — batch-fill multiple form fields by ref in one call
pub async fn handle_fill_form<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    // Convert snake_case field keys to camelCase for JS side
    let fields = payload
        .get("fields")
        .cloned()
        .unwrap_or(Value::Array(vec![]));
    let js_fields: Vec<Value> = if let Some(arr) = fields.as_array() {
        arr.iter()
            .map(|f| {
                serde_json::json!({
                    "ref": f.get("ref"),
                    "selectorType": f.get("selector_type"),
                    "selectorValue": f.get("selector_value"),
                    "value": f.get("value"),
                    "clear": f.get("clear")
                })
            })
            .collect()
    } else {
        vec![]
    };

    let js_payload = serde_json::json!({
        "fields": js_fields,
        "submitRef": payload.get("submit_ref").and_then(|v| v.as_i64())
    });

    // JS body lifted from handleFillFormRequest in guest-js/index.ts. Inlines
    // resolveElement + simulateReactInputTyping + typeIntoContentEditable so
    // the script is self-contained.
    let js_template = r#"
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const findElementByText = (text) => {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.textContent && el.textContent.trim() === text) return el;
    }
    for (const el of all) {
      if (el.textContent && el.textContent.trim().includes(text)) return el;
    }
    return null;
  };
  const getElementByRef = (ref) => {
    const map = window.__mcpPageMapRefs;
    if (map && typeof map.get === 'function') return map.get(ref) || null;
    return null;
  };
  const resolveElement = (field) => {
    if (typeof field.ref === 'number') return getElementByRef(field.ref);
    if (field.selectorType && field.selectorValue) {
      switch (field.selectorType) {
        case 'id': return document.getElementById(field.selectorValue);
        case 'class': return document.getElementsByClassName(field.selectorValue)[0] || null;
        case 'css': return document.querySelector(field.selectorValue);
        case 'tag': return document.getElementsByTagName(field.selectorValue)[0] || null;
        case 'text': return findElementByText(field.selectorValue);
        default: return null;
      }
    }
    return null;
  };
  const simulateReactInputTyping = async (element, text, delayMs) => {
    element.focus();
    await sleep(50);
    try {
      element.select();
      document.execCommand('delete', false);
      await sleep(50);
      if (delayMs > 0) {
        for (let i = 0; i < text.length; i++) {
          document.execCommand('insertText', false, text[i]);
          if (i < text.length - 1) await sleep(delayMs);
        }
      } else {
        document.execCommand('insertText', false, text);
      }
    } catch (e) {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(element, text); else element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  const typeIntoContentEditable = async (element, text, delayMs) => {
    element.focus();
    await sleep(50);
    for (let i = 0; i < text.length; i++) {
      document.execCommand('insertText', false, text[i]);
      if (delayMs > 0 && i < text.length - 1) await sleep(delayMs);
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
  };
  try {
    const payload = {{payload}};
    const fields = payload.fields;
    const submitRef = payload.submitRef;
    if (!Array.isArray(fields) || fields.length === 0) throw new Error('fields array is required and must not be empty');
    const results = [];
    for (const field of fields) {
      const entry = { ref: field.ref, success: false };
      try {
        const el = resolveElement(field);
        if (!el) {
          entry.error = 'Element not found (ref=' + field.ref + ', selector=' + field.selectorType + ':' + field.selectorValue + ')';
          results.push(entry);
          continue;
        }
        const clear = field.clear !== false;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.focus();
          await simulateReactInputTyping(el, field.value, 0);
        } else if (el instanceof HTMLSelectElement) {
          el.focus();
          el.value = field.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el instanceof HTMLElement && el.isContentEditable) {
          el.focus();
          if (clear) {
            el.innerHTML = '';
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          }
          await typeIntoContentEditable(el, field.value, 0);
        } else {
          entry.error = 'Element <' + el.tagName + '> is not a form field';
          results.push(entry);
          continue;
        }
        entry.success = true;
      } catch (fieldError) {
        entry.error = String(fieldError && fieldError.message ? fieldError.message : fieldError);
      }
      results.push(entry);
    }
    let submitResult = null;
    if (typeof submitRef === 'number') {
      const submitEl = getElementByRef(submitRef);
      if (submitEl && submitEl instanceof HTMLElement) {
        submitEl.click();
        submitResult = { clicked: true, tag: submitEl.tagName };
      } else {
        submitResult = { clicked: false, error: 'Submit element ref=' + submitRef + ' not found' };
      }
    }
    await window.__TAURI_INTERNALS__.invoke('mcp_result'|'mcp_result', {
      correlationId: {{correlationId}},
      ok: true,
      data: { fields: results, submit: submitResult },
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
        std::time::Duration::from_secs(30),
    )
    .await
    {
        Ok(envelope) => Ok(parse_envelope(envelope)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("eval_and_await failed for fill_form: {}", e)),
            id: None,
        }),
    }
}

/// JS body for `type_into_focused` — inlines simulateReactInputTyping,
/// typeIntoContentEditable, typeIntoLexicalEditor, typeIntoSlateEditor, and
/// isTypeable from guest-js/index.ts. Reads `window.__mcpLastFocusedElement`
/// (a hint installed by the existing focus listener in guest-js, plus a click
/// hint at `window.__mcpLastClickCoords`) so the typing strategy can recover
/// when the active element drifted between tool calls.
const TYPE_INTO_FOCUSED_JS: &str = r#"
(async () => {
  const isTypeable = (el) => {
    const tag = el && el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    if (el && el.hasAttribute && (el.hasAttribute('data-lexical-editor') || el.hasAttribute('data-slate-editor'))) return true;
    if (el && el.closest && (el.closest('[data-lexical-editor]') || el.closest('[data-slate-editor]'))) return true;
    return false;
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const simulateReactInputTyping = async (element, text, delayMs, clear = false) => {
    element.focus();
    await sleep(50);
    try {
      if (clear) {
        element.select();
        document.execCommand('delete', false);
        await sleep(50);
      }
      if (delayMs > 0) {
        for (let i = 0; i < text.length; i++) {
          document.execCommand('insertText', false, text[i]);
          if (i < text.length - 1) await sleep(delayMs);
        }
      } else {
        document.execCommand('insertText', false, text);
      }
    } catch (e) {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(element, text); else element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  const typeIntoContentEditable = async (element, text, delayMs) => {
    element.focus();
    await sleep(50);
    element.innerHTML = '';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    await sleep(50);
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: char, code: 'Key' + char.toUpperCase() }));
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection && selection.removeAllRanges();
      selection && selection.addRange(range);
      const node = document.createTextNode(char);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      selection && selection.removeAllRanges();
      selection && selection.addRange(range);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char }));
      element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: char, code: 'Key' + char.toUpperCase() }));
      if (delayMs > 0 && i < text.length - 1) await sleep(delayMs);
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const typeIntoLexicalEditor = async (element, text, delayMs) => {
    element.focus();
    await sleep(100);
    const paragraphs = element.querySelectorAll('p');
    if (paragraphs.length > 0) {
      for (const p of paragraphs) p.innerHTML = '<br>';
    } else {
      element.innerHTML = '<p class="editor-paragraph"><br></p>';
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    await sleep(100);
    const targetParagraph = element.querySelector('p') || element;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const active = document.activeElement;
      const target = (active && element.contains(active)) ? active : targetParagraph;
      const beforeInput = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: char });
      target.dispatchEvent(beforeInput);
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: char, code: 'Key' + char.toUpperCase(), composed: true }));
      if (!beforeInput.defaultPrevented) document.execCommand('insertText', false, char);
      target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char }));
      target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: char, code: 'Key' + char.toUpperCase(), composed: true }));
      if (delayMs > 0 && i < text.length - 1) await sleep(delayMs);
    }
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(targetParagraph);
      range.collapse(false);
      selection && selection.removeAllRanges();
      selection && selection.addRange(range);
    } catch (_) {}
  };
  const typeIntoSlateEditor = async (element, text, delayMs) => {
    element.focus();
    await sleep(100);
    const editable = element.querySelector('[contenteditable="true"]') || element;
    if (editable instanceof HTMLElement) editable.focus();
    document.execCommand('selectAll', false, undefined);
    document.execCommand('delete', false, undefined);
    await sleep(50);
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const active = document.activeElement || editable;
      active.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: char }));
      document.execCommand('insertText', false, char);
      active.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char }));
      active.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: char }));
      if (delayMs > 0 && i < text.length - 1) await sleep(delayMs);
    }
  };
  try {
    const payload = {{payload}};
    const text = payload.text;
    const delayMs = typeof payload.delayMs === 'number' ? payload.delayMs : 20;
    const initialDelayMs = typeof payload.initialDelayMs === 'number' ? payload.initialDelayMs : 0;
    if (!text) throw new Error('text parameter is required');
    if (initialDelayMs > 0) await sleep(initialDelayMs);

    let el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement || !isTypeable(el)) {
      el = window.__mcpLastFocusedElement || null;
    }
    if (!el || el === document.body || el === document.documentElement || !isTypeable(el)) {
      const coords = window.__mcpLastClickCoords;
      if (coords && typeof coords.x === 'number' && typeof coords.y === 'number') {
        let pointEl = document.elementFromPoint(coords.x, coords.y);
        while (pointEl && pointEl !== document.body) {
          if (isTypeable(pointEl)) break;
          pointEl = pointEl.parentElement;
        }
        if (pointEl && pointEl !== document.body && isTypeable(pointEl)) {
          el = pointEl;
          if (el instanceof HTMLElement) el.focus({ preventScroll: true });
          window.__mcpLastFocusedElement = el;
        }
      }
    }
    if (!el || el === document.body || el === document.documentElement) {
      throw new Error('No element is currently focused. Click an element first or use selector mode.');
    }
    if (el instanceof HTMLElement) el.focus();

    const elementInfo = { tag: el.tagName.toLowerCase() };
    if (el.id) elementInfo.id = el.id;
    if (el instanceof HTMLElement && el.className) elementInfo.className = String(el.className).substring(0, 100);

    if (el instanceof HTMLSelectElement) {
      elementInfo.strategy = 'select';
      const lower = text.toLowerCase().trim();
      let matched = false;
      for (const opt of el.options) {
        if (opt.text.toLowerCase().trim() === lower || opt.value.toLowerCase().trim() === lower) {
          opt.selected = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          matched = true;
          break;
        }
      }
      if (!matched) throw new Error('No <option> matching "' + text + '" found in <select>' + (el.id ? ' #' + el.id : '') + '.');
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      elementInfo.strategy = 'react-input';
      await simulateReactInputTyping(el, text, delayMs, false);
    } else if (el instanceof HTMLElement) {
      const lexicalEl = el.closest('[data-lexical-editor]') || (el.hasAttribute('data-lexical-editor') ? el : null);
      if (lexicalEl && lexicalEl instanceof HTMLElement) {
        elementInfo.strategy = 'lexical';
        await typeIntoLexicalEditor(lexicalEl, text, delayMs);
      } else {
        const slateEl = el.closest('[data-slate-editor]') || (el.hasAttribute('data-slate-editor') ? el : null);
        if (slateEl && slateEl instanceof HTMLElement) {
          elementInfo.strategy = 'slate';
          await typeIntoSlateEditor(slateEl, text, delayMs);
        } else if (el.isContentEditable) {
          elementInfo.strategy = 'contenteditable';
          await typeIntoContentEditable(el, text, delayMs);
        } else {
          elementInfo.strategy = 'execCommand-fallback';
          el.focus();
          const inserted = document.execCommand('insertText', false, text);
          if (!inserted) throw new Error('Cannot type into focused <' + el.tagName.toLowerCase() + '> element — it is not an editable field.');
        }
      }
    } else {
      throw new Error('Cannot type into focused <' + el.tagName.toLowerCase() + '> element — unsupported element type.');
    }

    await window.__TAURI_INTERNALS__.invoke('mcp_result'|'mcp_result', {
      correlationId: {{correlationId}},
      ok: true,
      data: { element: elementInfo, charsTyped: text.length },
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

/// Handler for type_into_focused — JS-based typing into the currently focused element
/// Detects element type (input/textarea, Lexical, Slate, contentEditable) and routes
/// to the appropriate JS typing strategy. Solves Lexical/Slate failures with native
/// NSEvent injection by using DOM-level event dispatch instead.
pub async fn handle_type_into_focused<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = payload
        .get("window_label")
        .and_then(|v| v.as_str())
        .unwrap_or("main")
        .to_string();

    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let text = payload
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if text.is_empty() {
        return Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some("text parameter is required and must not be empty".to_string()),
            id: None,
        });
    }

    let delay_ms = payload
        .get("delay_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(20);

    let mut js_payload = serde_json::json!({
        "text": text,
        "delayMs": delay_ms
    });
    if let Some(initial_delay) = payload.get("initial_delay_ms").and_then(|v| v.as_u64()) {
        js_payload["initialDelayMs"] = serde_json::json!(initial_delay);
    }

    let initial_delay_ms = payload
        .get("initial_delay_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Allow generous timeout for character-by-character typing + initial delay
    let timeout_secs = std::cmp::max(
        10,
        (text.len() as u64 * delay_ms + initial_delay_ms) / 1000 + 5,
    );

    match eval_and_await(
        app,
        &window_label,
        TYPE_INTO_FOCUSED_JS,
        js_payload,
        std::time::Duration::from_secs(timeout_secs),
    )
    .await
    {
        Ok(envelope) => Ok(parse_envelope(envelope)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!(
                "eval_and_await failed for type_into_focused: {}",
                e
            )),
            id: None,
        }),
    }
}

/// Handler for wait_for — wait for text/element to appear or disappear
pub async fn handle_wait_for<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _webview = crate::desktop::get_webview_for_eval(app, &window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Webview not found: {}", window_label))
    })?;

    let timeout_ms = payload
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(10000);

    let js_payload = serde_json::json!({
        "text": payload.get("text"),
        "selector": payload.get("selector"),
        "ref": payload.get("ref"),
        "state": payload.get("state").and_then(|v| v.as_str()).unwrap_or("visible"),
        "timeoutMs": timeout_ms
    });

    // Rust timeout = JS timeout + 2s buffer
    let rust_timeout_secs = (timeout_ms + 2000) / 1000;

    // JS body lifted from handleWaitForRequest in guest-js/index.ts.
    // Inlines isElementVisible + getElementByRef so it's self-contained.
    // getElementByRef pulls from window.__mcpPageMapRefs (a Map<number, Element>)
    // populated by the get_page_map port when it lands.
    let js_template = r#"
(async () => {
  const isElementVisible = (el) => {
    if (!(el instanceof HTMLElement)) return true;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hidden) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    if (style.overflow === 'hidden' && (rect.width <= 1 || rect.height <= 1)) return false;
    const position = style.position;
    if (position === 'absolute' || position === 'fixed') {
      const left = parseFloat(style.left);
      const top = parseFloat(style.top);
      if ((!isNaN(left) && left <= -9000) || (!isNaN(top) && top <= -9000)) return false;
    }
    return true;
  };
  const getElementByRef = (ref) => {
    const map = window.__mcpPageMapRefs;
    if (map && typeof map.get === 'function') return map.get(ref) || null;
    return null;
  };
  try {
    const payload = {{payload}};
    const text = payload.text;
    const selector = payload.selector;
    const refNum = payload.ref;
    const state = payload.state || 'visible';
    const timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : 10000;
    const pollInterval = 200;
    const result = await new Promise((resolve) => {
      const startTime = Date.now();
      let observer = null;
      const checkCondition = () => {
        if (typeof text === 'string') {
          const bodyText = (document.body && document.body.innerText) || '';
          const found = bodyText.includes(text);
          return state === 'hidden' ? !found : found;
        }
        let el = null;
        if (typeof refNum === 'number') {
          el = getElementByRef(refNum);
        } else if (typeof selector === 'string') {
          el = document.querySelector(selector);
        }
        switch (state) {
          case 'attached': return el !== null;
          case 'detached': return el === null;
          case 'hidden':
            if (!el) return true;
            return !isElementVisible(el);
          case 'visible':
          default:
            if (!el) return false;
            return isElementVisible(el);
        }
      };
      const finish = (found) => {
        if (observer) observer.disconnect();
        resolve({ found, elapsed: Date.now() - startTime });
      };
      if (checkCondition()) { finish(true); return; }
      const interval = setInterval(() => {
        if (checkCondition()) {
          clearInterval(interval);
          finish(true);
          return;
        }
        if (Date.now() - startTime >= timeoutMs) {
          clearInterval(interval);
          finish(false);
        }
      }, pollInterval);
      observer = new MutationObserver(() => {
        if (checkCondition()) {
          clearInterval(interval);
          finish(true);
        }
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      setTimeout(() => {
        clearInterval(interval);
        finish(checkCondition());
      }, timeoutMs);
    });
    await window.__TAURI_INTERNALS__.invoke('mcp_result'|'mcp_result', {
      correlationId: {{correlationId}},
      ok: true,
      data: { found: result.found, elapsed: result.elapsed, timedOut: !result.found },
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
        std::time::Duration::from_secs(rust_timeout_secs),
    )
    .await
    {
        Ok(envelope) => Ok(parse_envelope(envelope)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("eval_and_await failed for wait_for: {}", e)),
            id: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_js_response_success() {
        let input = r#"{"success":true,"data":{"url":"http://example.com"}}"#;
        let resp = parse_js_response(input);
        assert!(resp.success);
        assert!(resp.data.is_some());
        assert!(resp.error.is_none());
    }

    #[test]
    fn test_parse_js_response_failure() {
        let input = r#"{"success":false,"error":"something went wrong"}"#;
        let resp = parse_js_response(input);
        assert!(!resp.success);
        assert!(resp.data.is_none());
        assert_eq!(resp.error.as_deref(), Some("something went wrong"));
    }

    #[test]
    fn test_parse_js_response_double_encoded() {
        // JS sends JSON.stringify(obj) which the event system wraps in quotes
        let inner = r#"{"success":true,"data":{"key":"value"}}"#;
        let double_encoded = serde_json::to_string(inner).unwrap();
        let resp = parse_js_response(&double_encoded);
        assert!(resp.success);
        assert!(resp.data.is_some());
    }

    #[test]
    fn test_parse_js_response_garbage() {
        let resp = parse_js_response("not valid json at all {{{");
        assert!(!resp.success);
        assert_eq!(resp.error.as_deref(), Some("Unknown error"));
    }

    #[test]
    fn test_extract_window_label_string() {
        let payload = Value::String("main".to_string());
        assert_eq!(extract_window_label(&payload).unwrap(), "main");
    }

    #[test]
    fn test_extract_window_label_object() {
        let payload = serde_json::json!({"window_label": "preview"});
        assert_eq!(extract_window_label(&payload).unwrap(), "preview");
    }

    #[test]
    fn test_extract_window_label_invalid() {
        let payload = serde_json::json!(42);
        assert!(extract_window_label(&payload).is_err());
    }
}
