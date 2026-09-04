// @vitest-environment jsdom

import { act, createElement, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (command: string) => {
  if (command === 'realtime_invoke_tool') {
    return { capabilities: [
      {
        id: 'operator_attention', category: 'o8 work', title: 'Tell you what needs attention',
        summary: 'Read the live fleet.', examples: ['What needs me right now?'],
        toolNames: ['o8_needs_me'], availability: 'ready', approval: 'read_only',
      },
      {
        id: 'screen_guidance', category: 'This screen', title: 'Understand your screen',
        summary: 'Read the current screen.', examples: ['What am I looking at?'],
        toolNames: ['read_screen'], availability: 'setup_required',
        availabilityDetail: 'Allow Screen Recording in System Settings to use this capability.',
        approval: 'read_only',
      },
    ] };
  }
  if (command === 'symon_machine_list') {
    return { machines: [
      { id: 'local', displayName: 'This Mac', available: true },
      { id: 'macbook', displayName: 'MacBook', available: false },
    ] };
  }
  return { id: 'local', displayName: 'This Mac' };
});

interface MockMotionDivProps extends HTMLAttributes<HTMLDivElement> {
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
  transition?: unknown;
}

const motionState = vi.hoisted(() => ({
  latest: null as Pick<MockMotionDivProps, 'initial' | 'animate' | 'exit' | 'transition' | 'style'> | null,
}));

vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children, initial, animate, exit, transition, style, ...props }: MockMotionDivProps) => {
      motionState.latest = { initial, animate, exit, transition, style };
      return createElement('div', { ...props, style }, children);
    },
  },
  useReducedMotion: () => false,
}));

import { SymonMachineControl, SymonOrbStatusLine, setSymonOrbMinimized } from './SymonMachineControl';
import { capabilitiesFromToolResult } from './SymonCapabilitiesPanel';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('SymonMachineControl', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    motionState.latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('keeps the hydration render empty until the Tauri surface is detected', () => {
    expect(renderToString(createElement(SymonMachineControl))).toBe('');
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

  it('opens the truthful capability catalog and starts a selected prompt', async () => {
    await act(async () => root.render(createElement(SymonMachineControl)));
    await act(async () => {});

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Symon machine: This Mac"]');
    await act(async () => trigger?.click());
    const discover = container.querySelector<HTMLButtonElement>('button[aria-label="What Symon can do"]');
    expect(discover).not.toBeNull();

    await act(async () => discover?.click());
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('realtime_invoke_tool', {
      name: 'symon_capabilities',
      args: {},
      sessionId: 'desktop',
      utterance: 'Show Symon capabilities',
    });
    expect(container.textContent).toContain('Tell you what needs attention');
    expect(container.textContent).toContain('Setup needed');

    const starter = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('What needs me right now?'));
    expect(starter).not.toBeUndefined();
    await act(async () => starter?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(starter?.style.background).toBe('var(--t-hover)');
    await act(async () => starter?.click());
    expect(invoke).toHaveBeenCalledWith('agent_run', { prompt: 'What needs me right now?' });
    expect(container.querySelector('[aria-label="Symon capabilities"]')).toBeNull();
  });

  it('separates the blurred dialog without moving it and keeps the tooltip on the orb', async () => {
    await act(async () => root.render(createElement(SymonMachineControl)));
    await act(async () => {});

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Symon machine: This Mac"]');
    expect(trigger?.title).toBe('This Mac has the Symon session');
    expect(trigger?.parentElement?.hasAttribute('title')).toBe(false);

    await act(async () => trigger?.click());
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.closest('[title]')).toBeNull();
    expect(dialog?.style.background).toBe('color-mix(in srgb, var(--t-input-bg) 88%, transparent)');
    expect(dialog?.style.backdropFilter).toBe('blur(28px) saturate(1.2)');
    expect(motionState.latest?.style).toMatchObject({
      background: 'color-mix(in srgb, var(--t-input-bg) 88%, transparent)',
      backdropFilter: 'blur(28px) saturate(1.2)',
      WebkitBackdropFilter: 'blur(28px) saturate(1.2)',
    });
    expect(motionState.latest).toEqual({
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { type: 'spring', stiffness: 420, damping: 34 },
      style: expect.any(Object),
    });
  });

  it('unwraps the catalog returned by an active remote machine', () => {
    const capabilities = capabilitiesFromToolResult({
      source: 'symon_remote_machine_tool',
      observedData: {
        capabilities: [{
          id: 'remote_screen', category: 'This screen', title: 'Read the remote screen',
          summary: 'Remote capability.', examples: ['What is on that screen?'],
          toolNames: ['read_screen'], availability: 'ready', approval: 'read_only',
        }],
      },
    });
    expect(capabilities[0]?.id).toBe('remote_screen');
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
