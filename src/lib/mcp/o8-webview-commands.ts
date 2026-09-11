/**
 * The o8 webview socket command surface — one list, matching what the Rust
 * plugin actually dispatches.
 *
 * Rust source of truth: the `commands` module in
 * `tauri-plugin-mcp/src/shared/mod.rs` (constants), routed by `handle_command`
 * in `tauri-plugin-mcp/src/tools/mod.rs`. `o8-webview-commands.test.ts` parses
 * those constants and fails when this catalog drifts from them, so the list
 * cannot quietly go stale.
 *
 * Protocol notes that are easy to get wrong when driving the socket by hand:
 *
 * - `id` must be a STRING. An integer is rejected by the request deserializer
 *   with `Invalid request format: invalid type: integer 1, expected a string`,
 *   which reads like a protocol fault rather than a type error.
 *   `O8WebviewClient` always sends a string id.
 * - The verb field is NOT uniform. `manage_window` takes `operation`, while
 *   `navigate_webview`, `manage_events`, `manage_cookies`, `manage_zoom`,
 *   `manage_local_storage` and `manage_webview_state` take `action`. The typed
 *   client methods encode the right one per command so callers never guess.
 * - `window_label` defaults to `main` on the Rust side. o8 also runs the
 *   `dock`, `spatial-ink` and `agent-partials` overlay windows, which are only
 *   addressable by passing their label explicitly.
 * - Payload fields are snake_case for every command except `restart_app`,
 *   whose struct is `#[serde(rename_all = "camelCase")]` — it wants `delayMs`.
 *   `delay_ms` is silently ignored there and you get the 500ms default.
 */

export interface O8WebviewSocketCommand {
  /** Wire name, exactly as `handle_command` matches it. */
  readonly command: string;
  /**
   * True when the command changes app state. Mutating commands are NEVER
   * auto-retried after a dropped socket: the Rust side has usually already run
   * the action by the time the write fails, so a retry fires it twice.
   */
  readonly mutating: boolean;
  readonly summary: string;
}

export const O8_WEBVIEW_SOCKET_COMMANDS: readonly O8WebviewSocketCommand[] = [
  { command: 'ping', mutating: false, summary: 'Liveness probe.' },
  { command: 'take_screenshot', mutating: false, summary: 'Capture a window as base64 PNG/JPEG; works while the JS thread is busy.' },
  { command: 'get_dom', mutating: false, summary: 'Serialized DOM of a window.' },
  { command: 'manage_local_storage', mutating: true, summary: 'action: get / set / remove / clear on localStorage.' },
  { command: 'execute_js', mutating: true, summary: 'Evaluate code in a webview. Reads are common but the code can click and type, so it is never retry-safe.' },
  { command: 'manage_window', mutating: true, summary: 'operation: show / hide / focus / center / minimize / maximize / unmaximize / close / setPosition / setSize / toggleFullscreen.' },
  { command: 'simulate_text_input', mutating: true, summary: 'Native keystroke injection into a window.' },
  { command: 'simulate_mouse_movement', mutating: true, summary: 'Native pointer move / click / drag.' },
  { command: 'get_element_position', mutating: false, summary: 'Locate an element and return its viewport coordinates. Retry-safe only while `should_click` stays false, which is all this client ever sends.' },
  { command: 'send_text_to_element', mutating: true, summary: 'Focus an element and type into it.' },
  { command: 'get_page_map', mutating: false, summary: 'Numbered accessibility tree of a window.' },
  { command: 'get_page_state', mutating: false, summary: 'URL, title, readyState and viewport of a window.' },
  { command: 'navigate_back', mutating: true, summary: 'History back in a webview.' },
  { command: 'scroll_page', mutating: true, summary: 'Scroll by direction/amount or to a ref, top or bottom.' },
  { command: 'fill_form', mutating: true, summary: 'Set several form fields in one call.' },
  { command: 'wait_for', mutating: false, summary: 'Block until a selector resolves in a webview.' },
  { command: 'get_app_info', mutating: false, summary: 'Package name/version, OS, every window, and monitors with scale factors.' },
  { command: 'list_windows', mutating: false, summary: 'Every window with visible / focused / position / size — the app’s own truth about what is on screen.' },
  { command: 'navigate_webview', mutating: true, summary: 'action: navigate / reload / back / forward / get_url. A real webview navigation, not a history push.' },
  { command: 'manage_events', mutating: true, summary: 'action: emit / emit_to / listen on the internal Tauri event bus.' },
  { command: 'manage_cookies', mutating: true, summary: 'action: list / get / set / delete cookies.' },
  { command: 'manage_devtools', mutating: true, summary: 'Open or close devtools. Requires the plugin’s `devtools` feature.' },
  { command: 'manage_zoom', mutating: true, summary: 'Get or set a webview’s zoom factor.' },
  { command: 'manage_webview_state', mutating: true, summary: 'Read or restore webview state (scroll, focus, storage).' },
  { command: 'type_into_focused', mutating: true, summary: 'Type into whatever element currently holds focus.' },
  { command: 'restart_app', mutating: true, summary: 'Restart the whole app after a clamped 100–5000ms delay.' },
];

/**
 * Commands safe to re-fire after a reconnect: pure reads with no side effects.
 * Derived from the catalog so a new command is classified once, where it is
 * documented, instead of in a second hand-maintained list that can disagree.
 */
export const RECONNECT_RETRY_SAFE_COMMANDS: ReadonlySet<string> = new Set(
  O8_WEBVIEW_SOCKET_COMMANDS.filter((entry) => !entry.mutating).map((entry) => entry.command),
);
