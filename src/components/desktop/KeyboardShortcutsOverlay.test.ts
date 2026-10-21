// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createDashboardChromeKeydownHandler,
  type DashboardChromeShortcutActions,
} from '@/app/dashboard/dashboard-chrome-shortcuts';
import { KEYBOARD_SHORTCUT_SECTIONS, KeyboardShortcutsOverlay } from './KeyboardShortcutsOverlay';

const listeners: Array<(event: KeyboardEvent) => void> = [];

afterEach(() => {
  for (const listener of listeners.splice(0)) window.removeEventListener('keydown', listener);
});

function overlayLabelForChord(keys: string[]): string | undefined {
  for (const section of KEYBOARD_SHORTCUT_SECTIONS) {
    for (const row of section.rows) {
      if (row.chords.some((chord) => chord.length === keys.length && chord.every((key, i) => key === keys[i]))) {
        return row.label;
      }
    }
  }
  return undefined;
}

function installHandler() {
  const actions: DashboardChromeShortcutActions = {
    openCanvas: vi.fn(),
    openSettings: vi.fn(),
    spawnOrchestrator: vi.fn(),
    toggleBottomPanel: vi.fn(),
    toggleRightPanel: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleTerminalMode: vi.fn(),
  };
  const handler = createDashboardChromeKeydownHandler(actions);
  window.addEventListener('keydown', handler);
  listeners.push(handler);
  return actions;
}

describe('⌘T overlay label vs chrome handler', () => {
  it('labels ⌘T as a new orchestrator tab and routes the chord to spawnOrchestrator', () => {
    expect(overlayLabelForChord(['⌘', 'T'])).toBe('New orchestrator tab');

    const actions = installHandler();
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 't',
      metaKey: true,
      cancelable: true,
    }));

    expect(actions.spawnOrchestrator).toHaveBeenCalledOnce();
  });
});

it('contains help focus and restores its opener on Escape without closing underlying panels', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const underlying = vi.fn();
  window.addEventListener('keydown', underlying);
  function Harness() {
    const [open, setOpen] = useState(false);
    return createElement('div', null,
      createElement('button', { onClick: () => setOpen(true) }, 'Help'),
      createElement(KeyboardShortcutsOverlay, { open, onClose: () => setOpen(false) }),
    );
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    const opener = host.querySelector('button')!;
    opener.focus();
    await act(async () => opener.click());
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close keyboard shortcuts"]')!;
    expect(document.activeElement).toBe(close);
    await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    const shortcutList = host.querySelector<HTMLElement>('[aria-label="Shortcut list"]')!;
    expect(document.activeElement).toBe(shortcutList);
    underlying.mockClear();
    await act(async () => shortcutList.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(underlying).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('keydown', underlying);
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
