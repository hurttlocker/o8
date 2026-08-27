// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDashboardChromeKeydownHandler, type DashboardChromeShortcutActions } from './dashboard-chrome-shortcuts';

const listeners: Array<(event: KeyboardEvent) => void> = [];

afterEach(() => {
  for (const listener of listeners.splice(0)) window.removeEventListener('keydown', listener);
});

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

describe('dashboard chrome terminal shortcuts', () => {
  it('routes Command-Shift-J to Terminal Mode without toggling the bottom panel', () => {
    const actions = installHandler();
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyJ',
      key: 'j',
      metaKey: true,
      shiftKey: true,
      cancelable: true,
    }));

    expect(actions.toggleTerminalMode).toHaveBeenCalledOnce();
    expect(actions.toggleBottomPanel).not.toHaveBeenCalled();
  });

  it('keeps Command-J assigned to the bottom panel', () => {
    const actions = installHandler();
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyJ',
      key: 'j',
      metaKey: true,
      cancelable: true,
    }));

    expect(actions.toggleBottomPanel).toHaveBeenCalledOnce();
    expect(actions.toggleTerminalMode).not.toHaveBeenCalled();
  });
});
