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

import { SymonMachineControl } from './SymonMachineControl';

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
    expect(container.querySelector('select[aria-label="Active Symon machine"]')).toBeNull();

    await act(async () => trigger?.click());
    expect(container.querySelector('select[aria-label="Active Symon machine"]')).not.toBeNull();
    expect(container.textContent).toContain('Symon on');
  });
});
