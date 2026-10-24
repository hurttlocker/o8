// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FeedbackSettingsEntry } from './FeedbackSheet';

// Keep the real menu SDK and its Channel decoder; simulate only native IPC.
let root: Root | null; let host: HTMLDivElement; let enabled = true;
let label: string; let actionId: number | null; let sequence: number; let nextId: number;
let failCreate: boolean;
const callbacks = new Map<number, (message: unknown) => void>();
const invoke = vi.fn();
const props = { nativeMenu: true };
async function render(strict = false, settings = false) {
  const entries = createElement('div', null,
    createElement(FeedbackSettingsEntry, props),
    settings ? createElement(FeedbackSettingsEntry) : null);
  await act(async () => { root!.render(strict ? createElement(StrictMode, null, entries) : entries); });
  await act(async () => { await vi.dynamicImportSettled(); });
}
async function action() {
  expect(actionId).not.toBeNull();
  await act(async () => callbacks.get(actionId!)?.({ index: sequence++, message: 'o8-send-feedback' }));
}
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('__O8_HOST_PLATFORM__', 'macos');
  enabled = true; label = 'main'; actionId = null; sequence = 0; nextId = 10; failCreate = false;
  callbacks.clear(); invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'plugin:menu|create_default') { if (failCreate) throw new Error('Fixture unavailable'); return [1, 'default']; }
    if (command === 'plugin:menu|items') return [[2, 'help', 'Submenu'], [3, 'edit', 'Submenu']];
    if (command === 'plugin:menu|text') return args.rid === 2 ? 'Help' : 'Edit';
    if (command === 'plugin:menu|new') {
      actionId = (args.handler as { id: number }).id;
      return [4, (args.options as { id: string }).id];
    }
    if (command === 'plugin:menu|append' || command === 'plugin:resources|close') return;
    if (command === 'plugin:menu|set_as_app_menu') return [5, 'previous'];
    throw new Error(`Unexpected menu command: ${command}`);
  });
  vi.stubGlobal('__TAURI_INTERNALS__', {
    get metadata() { return { currentWindow: { label } }; }, invoke,
    transformCallback(callback: (message: unknown) => void) { const id = ++nextId; callbacks.set(id, callback); return id; },
    unregisterCallback(id: number) { callbacks.delete(id); },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/telemetry/config') return Response.json({ enabled });
    throw new Error(`Opening feedback must not submit or collect diagnostics: ${url}`);
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root?.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('adds the Help action through the real SDK and opens the shared sheet without a submission', async () => {
  await render(); expect(calls('plugin:menu|create_default')).toHaveLength(1);
  expect(calls('plugin:menu|append')[0][1]).toMatchObject({ rid: 2, items: [[4, 'MenuItem']] });
  expect(calls('plugin:menu|set_as_app_menu')).toHaveLength(1);
  expect(calls('plugin:menu|new')[0][1]).toMatchObject({ options: { id: 'o8-send-feedback', text: 'Send Feedback…' } });
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  await action();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.activeElement?.tagName).toBe('TEXTAREA');
  expect(vi.mocked(fetch).mock.calls.every(([url]) => url === '/api/telemetry/config')).toBe(true);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(calls('plugin:resources|close').map(([, args]) => (args as { rid: number }).rid).sort()).toEqual([1, 2, 3, 4, 5]);
});
it.each(['browser-view', 'voice-settings'])('does not change native menus in the %s window', async windowLabel => {
  label = windowLabel; await render(); expect(invoke).not.toHaveBeenCalled();
});
it.each(['windows', 'linux', undefined])('does not change native menus on %s', async platform => {
  vi.stubGlobal('__O8_HOST_PLATFORM__', platform); await render(); expect(invoke).not.toHaveBeenCalled();
});
it('does not call native IPC from an ordinary browser', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', undefined); await render(); expect(invoke).not.toHaveBeenCalled();
});
it('installs once through Strict Mode and remount while actions target only the current host', async () => {
  await render(true); expect(calls('plugin:menu|set_as_app_menu')).toHaveLength(1); expect(callbacks.size).toBe(1);
  await act(async () => root!.unmount()); root = null;
  await action(); expect(document.querySelector('[role="dialog"]')).toBeNull();
  root = createRoot(host); await render(); await action();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(calls('plugin:menu|set_as_app_menu')).toHaveLength(1); expect(callbacks.size).toBe(1);
});
it('shares one sheet with Settings and repeated native actions preserve the current draft', async () => {
  await render(false, true);
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Send Feedback…')!.click());
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  const input = document.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Retain this draft');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await action(); expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.querySelector('textarea')).toBe(input); expect(input.value).toBe('Retain this draft');
});
it('honors disabled report sharing when opened from Help', async () => {
  enabled = false; await render(); await action();
  const send = [...document.querySelectorAll('button')].find(button => button.textContent === 'Send feedback')!;
  expect(send.disabled).toBe(true); expect(document.body.textContent).toContain('crash & error reports');
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
});
it('refuses an old native callback after the window loses its main-window binding', async () => {
  await render(); label = 'browser-view'; await action(); expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('contains native setup failure and can recover on a later mount', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  failCreate = true; await render(); expect(calls('plugin:menu|set_as_app_menu')).toHaveLength(0);
  await act(async () => root!.unmount()); root = createRoot(host);
  failCreate = false; await render(); await action();
  expect(calls('plugin:menu|create_default')).toHaveLength(2);
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
});
