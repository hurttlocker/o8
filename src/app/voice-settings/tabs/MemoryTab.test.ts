// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMemory: vi.fn(async () => ({
    facts: [{
      id: 7,
      fact: 'I prefer aisle seats',
      state: 'active' as const,
      source: 'explicit',
      createdAt: 1,
      updatedAt: 2,
    }],
    suggestions: [{
      id: 9,
      fact: 'I prefer morning meetings',
      state: 'pending' as const,
      source: 'suggested',
      createdAt: 3,
      updatedAt: 4,
    }],
  })),
  addMemory: vi.fn(async () => ({})),
  updateMemory: vi.fn(async () => ({})),
  forgetMemory: vi.fn(async () => undefined),
  acceptSuggestion: vi.fn(async () => ({})),
  dismissSuggestion: vi.fn(async () => undefined),
}));

vi.mock('@/lib/tauri/bridge', () => ({
  symonMemoryGet: mocks.getMemory,
  symonMemoryAdd: mocks.addMemory,
  symonMemoryUpdate: mocks.updateMemory,
  symonMemoryForget: mocks.forgetMemory,
  symonMemoryAcceptSuggestion: mocks.acceptSuggestion,
  symonMemoryDismissSuggestion: mocks.dismissSuggestion,
}));

import MemoryTab from './MemoryTab';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('Symon Memory settings', () => {
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

  it('shows approved facts and keeps suggestions behind explicit review actions', async () => {
    await act(async () => root.render(createElement(MemoryTab)));
    await act(async () => {});

    expect(container.textContent).toContain('I prefer aisle seats');
    expect(container.textContent).toContain('I prefer morning meetings');
    expect(container.textContent).toContain('Inactive until you approve it');

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    await act(async () => buttons.find((button) => button.textContent === 'Forget')?.click());
    expect(mocks.forgetMemory).toHaveBeenCalledWith(7);

    await act(async () => buttons.find((button) => button.textContent === 'Approve')?.click());
    expect(mocks.acceptSuggestion).toHaveBeenCalledWith(9);

    await act(async () => buttons.find((button) => button.textContent === 'Dismiss')?.click());
    expect(mocks.dismissSuggestion).toHaveBeenCalledWith(9);
  });
});
