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

  beforeEach(() => {
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
    const onWorkerModelChange = vi.fn();
    await act(async () => { root.render(createElement(FleetWorkerChip, { onWorkerModelChange })); });
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

    expect(onWorkerModelChange).toHaveBeenCalledWith('openrouter/deepseek/deepseek-v4-flash');
  });

  it('lets the operator choose whether workers run or plan first', async () => {
    const onWorkerStartModeChange = vi.fn();
    await act(async () => { root.render(createElement(FleetWorkerChip, { onWorkerStartModeChange })); });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Fleet worker"]');
    act(() => trigger?.click());

    const planFirst = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Plan first');
    expect(planFirst).toBeDefined();
    expect(planFirst?.title).toBe(
      'The worker reads the task, shares a plan with the lead, and waits before editing.',
    );
    await act(async () => { planFirst?.click(); await Promise.resolve(); });

    expect(onWorkerStartModeChange).toHaveBeenCalledWith('huddle');
  });
});
