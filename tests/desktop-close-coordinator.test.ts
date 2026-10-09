// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopCloseCoordinator } from '@/components/desktop/DesktopCloseCoordinator';

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  onClose: null as ((event: { payload: { workingCount: number | null } }) => void) | null,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('desktop close event to rendered decision sheet', () => {
  let host: HTMLDivElement;
  let root: Root;
  let appControl: HTMLButtonElement;
  let appAction: () => void;

  beforeEach(() => {
    native.invoke.mockReset().mockResolvedValue(true);
    native.listen.mockReset().mockImplementation(async (_event, handler) => {
      native.onClose = handler;
      return native.unlisten;
    });
    native.unlisten.mockReset();
    native.onClose = null;
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { metadata: { currentWindow: { label: 'main' } } },
    });
    appControl = document.createElement('button');
    appControl.textContent = 'Inspect work';
    appAction = vi.fn();
    appControl.addEventListener('click', appAction);
    document.body.appendChild(appControl);
    appControl.focus();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    appControl.remove();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  async function mount() {
    await act(async () => { root.render(createElement(DesktopCloseCoordinator)); });
    expect(native.listen).toHaveBeenCalledWith('desktop-close-requested', expect.any(Function));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  }

  function requestClose(workingCount: number | null) {
    expect(native.onClose).not.toBeNull();
    act(() => native.onClose!({ payload: { workingCount } }));
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog!.getAttribute('aria-labelledby')!)?.textContent)
      .toBe(workingCount === null ? 'Agents may still be working' : `${workingCount} agents are still working`);
    return dialog!;
  }

  function button(label: string) {
    const control = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((candidate) => candidate.textContent === label);
    expect(control, `button ${label}`).toBeDefined();
    return control!;
  }

  function rememberChoice() {
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  }

  function pressKey(key: string, shiftKey = false) {
    const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    act(() => document.activeElement!.dispatchEvent(event));
    return event;
  }

  function clickBackdrop() {
    act(() => host.querySelector<HTMLElement>('[role="presentation"]')!.click());
  }

  function expectCancelled() {
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    // The real bridge can only change native visibility, processes or preferences through IPC.
    expect(native.invoke).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(appControl);
    act(() => appControl.click());
    expect(appAction).toHaveBeenCalledOnce();
  }

  for (const workingCount of [2, null]) {
    for (const dismissal of ['Cancel', 'Escape', 'backdrop']) {
      it(`returns to the app without native IPC via ${dismissal}, count=${workingCount}`, async () => {
        await mount();
        const dialog = requestClose(workingCount);
        rememberChoice();
        // Clicking the sheet itself must not cancel it or select a close action.
        act(() => dialog.click());
        expect(host.querySelector('[role="dialog"]')).toBe(dialog);
        if (dismissal === 'Cancel') act(() => button('Cancel').click());
        else if (dismissal === 'Escape') expect(pressKey('Escape').defaultPrevented).toBe(true);
        else clickBackdrop();
        expectCancelled();
      });
    }
  }

  it('contains keyboard and programmatic focus, then restores the previous app control', async () => {
    await mount();
    const dialog = requestClose(2);
    expect(document.activeElement).toBe(button('Cancel'));
    const controls = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'));
    act(() => controls[0].focus());
    expect(pressKey('Tab', true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[controls.length - 1]);
    expect(pressKey('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[0]);
    act(() => appControl.focus());
    expect(dialog.contains(document.activeElement)).toBe(true);
    act(() => button('Cancel').click());
    expectCancelled();
  });

  it('refreshes the count and forgets an uncommitted choice on repeated close requests', async () => {
    await mount();
    requestClose(2);
    rememberChoice();
    act(() => button('Cancel').click());
    expectCancelled();
    requestClose(null);
    expect(host.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    pressKey('Escape');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(appControl);
    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.listen).toHaveBeenCalledOnce();
  });

  for (const action of ['background', 'quit'] as const) {
    for (const remember of [false, true]) {
      it(`preserves explicit ${action} resolution with remember=${remember}`, async () => {
        await mount();
        requestClose(null);
        if (remember) rememberChoice();
        await act(async () => button(action === 'quit' ? 'Stop and quit' : 'Keep working in the background').click());
        expect(native.invoke).toHaveBeenCalledExactlyOnceWith('resolve_desktop_close', { action, remember });
        expect(host.querySelector('[role="dialog"]')).toBeNull();
      });
    }
  }

  it('keeps an explicit close choice pending and refuses cancellation or duplicate requests until it settles', async () => {
    let finish!: (accepted: boolean) => void;
    native.invoke.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    await mount();
    const dialog = requestClose(2);
    await act(async () => button('Keep working in the background').click());
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('resolve_desktop_close', { action: 'background', remember: false });
    requestClose(2);
    expect(Array.from(dialog.querySelectorAll('button')).every((control) => control.disabled)).toBe(true);
    act(() => button('Cancel').click());
    pressKey('Escape');
    clickBackdrop();
    expect(host.querySelector('[role="dialog"]')).toBe(dialog);
    expect(pressKey('Tab').defaultPrevented).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => finish(true));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(native.invoke).toHaveBeenCalledOnce();
  });

  it('allows cancellation after a rejected close choice and clears its error on the next request', async () => {
    native.invoke.mockResolvedValue(false);
    await mount();
    requestClose(2);
    await act(async () => button('Stop and quit').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not apply');
    expect(button('Cancel').disabled).toBe(false);
    pressKey('Escape');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(appControl);
    requestClose(null);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    clickBackdrop();
    expect(native.invoke).toHaveBeenCalledOnce();
  });

  it('returns to another usable app control if the previous control was removed', async () => {
    await mount();
    requestClose(null);
    const replacement = document.createElement('button');
    replacement.textContent = 'Inspect another task';
    appControl.replaceWith(replacement);
    try {
      act(() => button('Cancel').click());
      expect(document.activeElement).toBe(replacement);
      expect(native.invoke).not.toHaveBeenCalled();
    } finally {
      replacement.remove();
    }
  });

  it('unsubscribes from the native close event when the coordinator unmounts', async () => {
    await mount();
    act(() => root.render(null));
    expect(native.unlisten).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
