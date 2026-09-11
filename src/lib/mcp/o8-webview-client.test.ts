import {
  afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance,
} from 'vitest';

import { O8WebviewClient } from './o8-webview-client';
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

/**
 * The window/app commands the client gained for #2151. These exercise the real
 * sendCommand path (so the retry classification is under test too) and stub
 * only the single-shot socket write.
 */
describe('O8WebviewClient window and app commands', () => {
  type ClientInternals = {
    sendCommandOnce(command: string, payload: Record<string, unknown>): Promise<unknown>;
  };

  let client: O8WebviewClient;
  let sendOnce: MockInstance<ClientInternals['sendCommandOnce']>;
  let previousSocketEnv: string | undefined;

  beforeAll(() => {
    previousSocketEnv = process.env.O8_TAURI_MCP_SOCKET;
    process.env.O8_TAURI_MCP_SOCKET = '/tmp/o8-webview-client-test.sock';
    client = new O8WebviewClient();
    sendOnce = vi.spyOn(client as unknown as ClientInternals, 'sendCommandOnce');
  });

  afterAll(() => {
    sendOnce.mockRestore();
    if (previousSocketEnv === undefined) delete process.env.O8_TAURI_MCP_SOCKET;
    else process.env.O8_TAURI_MCP_SOCKET = previousSocketEnv;
  });

  beforeEach(() => {
    sendOnce.mockReset();
  });

  function epipe(): Error {
    const error = new Error('write EPIPE') as Error & { code?: string };
    error.code = 'EPIPE';
    return error;
  }

  it('lists windows with their visible/focused state', async () => {
    sendOnce.mockResolvedValue({
      windows: [
        { label: 'main', visible: true, focused: false },
        { label: 'agent-partials', visible: true, focused: true },
      ],
    });

    const result = await client.listWindows();

    expect(sendOnce).toHaveBeenCalledWith('list_windows', {});
    // The observed failure this exists for: an overlay holds focus, main does not.
    expect(result.windows.find((window) => window.focused)?.label).toBe('agent-partials');
  });

  it('returns an empty window list rather than throwing on a malformed response', async () => {
    sendOnce.mockResolvedValue(null);
    await expect(client.listWindows()).resolves.toEqual({ windows: [] });
  });

  it('unwraps a doubly-nested data envelope', async () => {
    sendOnce.mockResolvedValue({ data: { windows: [{ label: 'dock' }] } });
    const result = await client.listWindows();
    expect(result.windows).toEqual([{ label: 'dock' }]);
  });

  it('reads app info including monitors', async () => {
    sendOnce.mockResolvedValue({
      app: { name: 'o8', version: '0.1.0' },
      monitors: [{ name: 'Built-in', scaleFactor: 2 }],
    });

    const info = await client.getAppInfo();

    expect(sendOnce).toHaveBeenCalledWith('get_app_info', {});
    expect(info.monitors?.[0]?.scaleFactor).toBe(2);
  });

  it('sends manage_window with `operation`, not `action`', async () => {
    sendOnce.mockResolvedValue({ success: true });

    await client.manageWindow({ operation: 'focus', windowLabel: 'main' });

    const [command, payload] = sendOnce.mock.calls[0];
    expect(command).toBe('manage_window');
    expect(payload).toEqual({ window_label: 'main', operation: 'focus' });
    expect(payload).not.toHaveProperty('action');
  });

  it('defaults manage_window to the main window and omits unset geometry', async () => {
    sendOnce.mockResolvedValue({ success: true });
    await client.manageWindow({ operation: 'center' });
    expect(sendOnce).toHaveBeenCalledWith('manage_window', { window_label: 'main', operation: 'center' });
  });

  it('passes geometry through for setPosition', async () => {
    sendOnce.mockResolvedValue({ success: true });
    await client.manageWindow({ operation: 'setPosition', windowLabel: 'dock', x: 10, y: 20 });
    expect(sendOnce).toHaveBeenCalledWith('manage_window', {
      window_label: 'dock', operation: 'setPosition', x: 10, y: 20,
    });
  });

  it('sends navigate_webview with `action`, not `operation`', async () => {
    sendOnce.mockResolvedValue({ action: 'reload' });

    await client.navigateWebview({ action: 'reload' });

    const [command, payload] = sendOnce.mock.calls[0];
    expect(command).toBe('navigate_webview');
    expect(payload).toEqual({ window_label: 'main', action: 'reload' });
    expect(payload).not.toHaveProperty('operation');
  });

  it('keeps navigate() on the SPA bridge rather than a real navigation', async () => {
    // Regression guard for issue #863: routing o8's own page moves through
    // navigate_webview triggers a full document load and freezes the route.
    sendOnce.mockResolvedValue({ result: '/dashboard' });

    await client.navigate('/dashboard');

    const [command, payload] = sendOnce.mock.calls[0];
    expect(command).toBe('execute_js');
    expect(String(payload.code)).toContain('__o8Navigate__');
  });

  it('sends restart_app with the camelCase delay the plugin expects', async () => {
    sendOnce.mockResolvedValue({ message: 'Restarting application in 250ms' });
    await client.restartApp({ delayMs: 250 });
    expect(sendOnce).toHaveBeenCalledWith('restart_app', { delayMs: 250 });
  });

  it('maps manageEvents options onto the snake_case payload', async () => {
    sendOnce.mockResolvedValue({ emitted: 'o8:test' });
    await client.manageEvents({ action: 'emit', event: 'o8:test', payload: { a: 1 }, durationMs: 500 });
    expect(sendOnce).toHaveBeenCalledWith('manage_events', {
      action: 'emit', event: 'o8:test', payload: { a: 1 }, duration_ms: 500,
    });
  });

  it('retries list_windows after a dropped socket', async () => {
    sendOnce.mockRejectedValueOnce(epipe()).mockResolvedValueOnce({ windows: [{ label: 'main' }] });

    await expect(client.listWindows()).resolves.toEqual({ windows: [{ label: 'main' }] });
    expect(sendOnce).toHaveBeenCalledTimes(2);
  });

  it('refuses to retry manage_window after a dropped socket', async () => {
    // Retrying would run the window operation a second time.
    sendOnce.mockRejectedValue(epipe());

    await expect(client.manageWindow({ operation: 'hide', windowLabel: 'dock' }))
      .rejects.toThrow(/may have already executed/);
    expect(sendOnce).toHaveBeenCalledTimes(1);
  });

  it('refuses to retry navigate_webview or restart_app after a dropped socket', async () => {
    sendOnce.mockRejectedValue(epipe());

    await expect(client.navigateWebview({ action: 'navigate', url: 'https://example.test' }))
      .rejects.toThrow(/may have already executed/);
    await expect(client.restartApp()).rejects.toThrow(/may have already executed/);
    expect(sendOnce).toHaveBeenCalledTimes(2);
  });
});
