// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsTab } from './PermissionsTab';

const shell = window as unknown as {
  __TAURI_INTERNALS__?: { invoke: ReturnType<typeof vi.fn> };
  __O8_HOST_PLATFORM__?: string;
};
const statusCommands = [
  'mic_permission_granted_cmd', 'accessibility_permission_granted_cmd',
  'input_monitoring_granted_cmd', 'screen_capture_granted_cmd',
];

describe('Permissions tab native platform boundary', () => {
  let host: HTMLDivElement;
  let root: Root;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Load the real IPC transport before controlling the test clock.
    await import('@tauri-apps/api/core');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    invoke = vi.fn().mockResolvedValue(true);
    shell.__TAURI_INTERNALS__ = { invoke };
    shell.__O8_HOST_PLATFORM__ = 'macos';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete shell.__TAURI_INTERNALS__;
    delete shell.__O8_HOST_PLATFORM__;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const pills = (host: HTMLElement, text: string) => Array.from(host.querySelectorAll('span'))
    .filter((span) => span.childElementCount === 0 && span.textContent === text);

  it.each(['linux', 'windows'])('keeps %s compatibility values unverified across polling and remounts', async (platform) => {
    shell.__O8_HOST_PLATFORM__ = platform;
    for (let visit = 0; visit < 2; visit += 1) {
      await act(async () => root.render(createElement(PermissionsTab)));
      await act(async () => vi.advanceTimersByTimeAsync(2100));
      expect(pills(host, 'Not checked on this platform')).toHaveLength(4);
      expect(host.textContent).toContain('System permission checks');
      expect(host.textContent).not.toContain('macOS');
      expect(pills(host, 'Granted')).toHaveLength(0);
      expect(pills(host, 'Denied')).toHaveLength(0);
      expect(host.querySelectorAll('button')).toHaveLength(0);
      expect(host.querySelectorAll('svg[stroke="#22c55e"]')).toHaveLength(0);
      expect(invoke).not.toHaveBeenCalled();
      await act(async () => root.render(null));
    }
  });

  it('renders macOS granted, denied and never-asked results through the production bridge', async () => {
    invoke.mockImplementation(async (command: string) => command === 'mic_permission_granted_cmd'
      ? null : command === 'input_monitoring_granted_cmd');
    await act(async () => root.render(createElement(PermissionsTab)));
    expect(pills(host, 'Not asked')).toHaveLength(1);
    expect(pills(host, 'Denied')).toHaveLength(2);
    expect(pills(host, 'Granted')).toHaveLength(1);
    expect(host.textContent).toContain('macOS permissions');
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Allow…', 'Open Settings', 'Open Settings']);
    expect(invoke.mock.calls.map(([command]) => command).sort()).toEqual([...statusCommands].sort());
  });

  it('keeps first-read macOS grants free of relaunch actions', async () => {
    await act(async () => root.render(createElement(PermissionsTab)));
    expect(pills(host, 'Granted')).toHaveLength(4);
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it('retains macOS live-grant detection and stops polling when navigated away', async () => {
    let granted = false;
    invoke.mockImplementation(async () => granted);
    await act(async () => root.render(createElement(PermissionsTab)));
    expect(pills(host, 'Denied')).toHaveLength(4);
    granted = true;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(pills(host, 'Granted')).toHaveLength(4);
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toEqual(Array(3).fill('Relaunch o8 to apply'));
    expect(invoke).toHaveBeenCalledTimes(8);
    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTimeAsync(2100));
    expect(invoke).toHaveBeenCalledTimes(8);
    await act(async () => root.render(createElement(PermissionsTab)));
    expect(pills(host, 'Granted')).toHaveLength(4);
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(invoke.mock.calls.every(([command]) => statusCommands.includes(String(command)))).toBe(true);
  });

  it('keeps a pending macOS check distinct from a grant or a denial', async () => {
    invoke.mockImplementation(() => new Promise(() => {}));
    await act(async () => root.render(createElement(PermissionsTab)));
    expect(pills(host, 'Checking…')).toHaveLength(4);
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('does not read native permissions from a browser', async () => {
    delete shell.__TAURI_INTERNALS__;
    await act(async () => root.render(createElement(PermissionsTab)));
    expect(host.textContent).toContain('only manageable from the desktop app');
    expect(invoke).not.toHaveBeenCalled();
  });
});
