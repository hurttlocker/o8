// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (command: string) => {
  if (command === 'symon_machine_list') {
    return { machines: [
      { id: 'local', displayName: 'This Mac', available: true },
      { id: 'macbook', displayName: 'MacBook', available: false },
    ] };
  }
  return { id: 'local', displayName: 'This Mac' };
});

vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: 'div' },
  useReducedMotion: () => false,
}));

import { SymonMachineControl, SymonOrbStatusLine, setSymonOrbMinimized } from './SymonMachineControl';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('SymonMachineControl', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('uses a compact bottom-right trigger and reveals machine selection on demand', async () => {
    await act(async () => root.render(createElement(SymonMachineControl)));
    await act(async () => {});

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Symon machine: This Mac"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.parentElement?.style.bottom).toBe('120px');
    expect(trigger?.parentElement?.style.zIndex).toBe('50');
    expect(trigger?.parentElement?.style.top).toBe('');
    // No center pane in jsdom — the anchor falls back to the viewport inset.
    expect(trigger?.parentElement?.style.right).toBe('16px');
    expect(container.querySelector('select[aria-label="Active Symon machine"]')).toBeNull();

    await act(async () => trigger?.click());
    expect(container.querySelector('select[aria-label="Active Symon machine"]')).not.toBeNull();
    expect(container.textContent).toContain('Symon on');
  });

  it('anchors to the center pane right edge when the workspace element exists', async () => {
    const pane = document.createElement('div');
    pane.setAttribute('data-o8-workspace', '1');
    pane.getBoundingClientRect = () => ({
      right: 800, left: 0, top: 0, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    document.body.appendChild(pane);
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    try {
      await act(async () => root.render(createElement(SymonMachineControl)));
      await act(async () => {});
      const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Symon machine: This Mac"]');
      // innerWidth 1200 − pane.right 800 + 16 inset = 416: the orb sits beside
      // the composer, not over an open right panel.
      expect(trigger?.parentElement?.style.right).toBe('416px');
    } finally {
      pane.remove();
    }
  });

  it('minimizes to the status-bar line and restores from it', async () => {
    await act(async () => root.render(createElement(SymonMachineControl)));
    await act(async () => {});

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Symon machine: This Mac"]');
    await act(async () => trigger?.click());
    const minimize = container.querySelector<HTMLButtonElement>('button[aria-label="Minimize Symon to the status bar"]');
    expect(minimize).not.toBeNull();

    await act(async () => minimize?.click());
    // The orb is gone…
    expect(container.querySelector('button[aria-label^="Symon machine:"]')).toBeNull();

    // …and the status-bar line renders and restores him.
    const lineHost = document.createElement('div');
    document.body.appendChild(lineHost);
    const lineRoot = createRoot(lineHost);
    try {
      await act(async () => lineRoot.render(createElement(SymonOrbStatusLine)));
      const restore = lineHost.querySelector<HTMLButtonElement>('button[aria-label="Restore Symon"]');
      expect(restore).not.toBeNull();
      await act(async () => restore?.click());
      expect(container.querySelector('button[aria-label^="Symon machine:"]')).not.toBeNull();
      expect(lineHost.querySelector('button[aria-label="Restore Symon"]')).toBeNull();
    } finally {
      await act(async () => lineRoot.unmount());
      lineHost.remove();
      setSymonOrbMinimized(false);
    }
  });
});
