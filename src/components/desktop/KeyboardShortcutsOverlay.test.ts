// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDashboardChromeKeydownHandler,
  type DashboardChromeShortcutActions,
} from '@/app/dashboard/dashboard-chrome-shortcuts';
import { KEYBOARD_SHORTCUT_SECTIONS } from './KeyboardShortcutsOverlay';

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
