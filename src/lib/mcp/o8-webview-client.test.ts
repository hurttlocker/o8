import { describe, expect, it } from 'vitest';

import { resolveO8WebviewSocketPath } from './o8-webview-socket';

describe('resolveO8WebviewSocketPath', () => {
  it('refuses the installed-app socket when a data-dir override is active', () => {
    expect(() => resolveO8WebviewSocketPath({
      CORTEX_IDE_DATA_DIR: '/tmp/o8-isolated-tests',
    }, 'operator')).toThrow(/refusing to fall back to the installed app WebView socket/);
  });

  it('accepts an explicit socket with an isolated data dir', () => {
    expect(resolveO8WebviewSocketPath({
      CORTEX_IDE_DATA_DIR: '/tmp/o8-isolated-tests',
      O8_TAURI_MCP_SOCKET: '/tmp/o8-isolated-tests/webview.sock',
    }, 'operator')).toBe('/tmp/o8-isolated-tests/webview.sock');
  });

  it('retains the installed-app default without a data-dir override', () => {
    expect(resolveO8WebviewSocketPath({}, 'operator'))
      .toBe('/tmp/tauri-mcp-o8-operator.sock');
  });
});
