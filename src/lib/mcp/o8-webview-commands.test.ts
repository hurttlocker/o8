import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  O8_WEBVIEW_SOCKET_COMMANDS,
  RECONNECT_RETRY_SAFE_COMMANDS,
} from './o8-webview-commands';

// Resolved from this file, not the working directory, so the drift guard holds
// wherever the runner is launched from.
const PLUGIN_SHARED_MOD = fileURLToPath(new URL('../../../tauri-plugin-mcp/src/shared/mod.rs', import.meta.url));
const PLUGIN_DISPATCHER = fileURLToPath(new URL('../../../tauri-plugin-mcp/src/tools/mod.rs', import.meta.url));

/** Every `pub const NAME: &str = "value";` inside the plugin's `commands` module. */
function readPluginCommandConstants(): string[] {
  const source = readFileSync(PLUGIN_SHARED_MOD, 'utf8');
  const moduleStart = source.indexOf('pub mod commands {');
  expect(moduleStart, 'plugin no longer declares a `commands` module').toBeGreaterThan(-1);

  const body = source.slice(moduleStart);
  return [...body.matchAll(/pub const [A-Z_]+: &str = "([a-z_]+)";/g)].map((match) => match[1]);
}

describe('o8 webview socket command catalog', () => {
  it('lists exactly the commands the plugin declares', () => {
    const declared = readPluginCommandConstants();
    expect(declared.length).toBeGreaterThan(0);
    expect([...O8_WEBVIEW_SOCKET_COMMANDS].map((entry) => entry.command).sort())
      .toEqual([...declared].sort());
  });

  it('lists exactly the commands the dispatcher routes', () => {
    // handle_command matches on `commands::NAME`; a constant that exists but is
    // never routed would be documented here as reachable when it is not.
    const dispatcher = readFileSync(PLUGIN_DISPATCHER, 'utf8');
    const routed = new Set(
      [...dispatcher.matchAll(/commands::([A-Z_]+) =>/g)].map((match) => match[1]),
    );
    const shared = readFileSync(PLUGIN_SHARED_MOD, 'utf8');
    const constantNames = new Map(
      [...shared.matchAll(/pub const ([A-Z_]+): &str = "([a-z_]+)";/g)]
        .map((match) => [match[1], match[2]] as const),
    );

    const routedWireNames = [...routed].map((name) => constantNames.get(name)).sort();
    expect([...O8_WEBVIEW_SOCKET_COMMANDS].map((entry) => entry.command).sort())
      .toEqual(routedWireNames);
  });

  it('has no duplicate entries', () => {
    const names = O8_WEBVIEW_SOCKET_COMMANDS.map((entry) => entry.command);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every command a summary', () => {
    for (const entry of O8_WEBVIEW_SOCKET_COMMANDS) {
      expect(entry.summary.length, `${entry.command} has no summary`).toBeGreaterThan(0);
    }
  });
});

describe('reconnect retry safety', () => {
  it('keeps the commands that were already retry-safe', () => {
    // Behavioral lock: these three were the hand-maintained set before the
    // catalog derived it. Reclassifying one is a real change, not a refactor.
    for (const command of ['get_page_map', 'get_element_position', 'take_screenshot']) {
      expect(RECONNECT_RETRY_SAFE_COMMANDS.has(command), command).toBe(true);
    }
  });

  it('treats the new read-only commands as retry-safe', () => {
    expect(RECONNECT_RETRY_SAFE_COMMANDS.has('list_windows')).toBe(true);
    expect(RECONNECT_RETRY_SAFE_COMMANDS.has('get_app_info')).toBe(true);
  });

  it('never retries a command that mutates app or window state', () => {
    // A retried window operation runs twice. Name the mutators explicitly so a
    // future `mutating: false` typo on one of them fails here.
    const mustNotRetry = [
      'manage_window',
      'navigate_webview',
      'manage_events',
      'restart_app',
      'execute_js',
      'type_into_focused',
      'scroll_page',
      'simulate_text_input',
      'simulate_mouse_movement',
      'send_text_to_element',
      'fill_form',
      'navigate_back',
      'manage_local_storage',
      'manage_cookies',
      'manage_devtools',
      'manage_zoom',
      'manage_webview_state',
    ];
    for (const command of mustNotRetry) {
      expect(RECONNECT_RETRY_SAFE_COMMANDS.has(command), `${command} must not auto-retry`).toBe(false);
    }
  });

  it('derives the set from the catalog rather than a second list', () => {
    const expected = O8_WEBVIEW_SOCKET_COMMANDS
      .filter((entry) => !entry.mutating)
      .map((entry) => entry.command)
      .sort();
    expect([...RECONNECT_RETRY_SAFE_COMMANDS].sort()).toEqual(expected);
  });
});
