// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FleetWorkerChip } from './ComposerFleetChips';

vi.mock('./chat-panel/ComposerPopover', async () => {
  const React = await import('react');
  return {
    ComposerPopover: ({ open, children }: { open: boolean; children: import('react').ReactNode }) => (
      open ? React.createElement('div', null, children) : null
    ),
  };
});

vi.mock('./AcpModelPicker', async () => {
  const React = await import('react');
  return {
    AcpModelPicker: ({ onSelect }: { onSelect: (modelId: string) => void }) => React.createElement(
      'button',
      { type: 'button', onClick: () => onSelect('openrouter/deepseek/deepseek-v4-flash') },
      'Pick worker model',
    ),
  };
});

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('FleetWorkerChip', () => {
  let container: HTMLDivElement;
  let root: Root;
  let requests: Array<{ method: string; body: Record<string, unknown> | null }>;

  beforeEach(() => {
    requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      requests.push({ method, body });
      return new Response(JSON.stringify({
        values: {
          defaultDispatchRuntime: body?.defaultDispatchRuntime ?? 'codex',
          defaultDispatchModel: '',
          opencodeWorkerModel: body?.opencodeWorkerModel ?? null,
          workerStartMode: body?.workerStartMode ?? 'autonomous',
        },
        sources: {},
      }), { status: 200 });
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('sets the OpenCode 2 worker model from the fleet popover', async () => {
    await act(async () => { root.render(createElement(FleetWorkerChip)); });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Fleet worker"]');
    act(() => trigger?.click());

    const opencode = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('OpenCode 2'));
    expect(opencode).toBeDefined();
    await act(async () => { opencode?.click(); await Promise.resolve(); });

    const pick = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Pick worker model');
    expect(pick).toBeDefined();
    await act(async () => { pick?.click(); await Promise.resolve(); });

    expect(requests).toContainEqual({
      method: 'POST',
      body: { opencodeWorkerModel: 'openrouter/deepseek/deepseek-v4-flash' },
    });
  });

  it('lets the operator choose whether workers run or ask first', async () => {
    await act(async () => { root.render(createElement(FleetWorkerChip)); });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Fleet worker"]');
    act(() => trigger?.click());

    const askFirst = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Ask first');
    expect(askFirst).toBeDefined();
    await act(async () => { askFirst?.click(); await Promise.resolve(); });

    expect(requests).toContainEqual({
      method: 'POST',
      body: { workerStartMode: 'huddle' },
    });
  });
});
