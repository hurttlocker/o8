// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }));

import {
  symonMemoryAcceptSuggestion,
  symonMemoryAdd,
  symonMemoryDismissSuggestion,
  symonMemoryForget,
  symonMemoryGet,
  symonMemoryUpdate,
} from './bridge';

const entry = {
  id: 7,
  fact: 'I prefer aisle seats',
  state: 'active',
  source: 'settings',
  createdAt: 1,
  updatedAt: 2,
};

describe('Symon memory Tauri bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    tauriInvoke.mockImplementation(async (command: string) => (
      command === 'symon_memory_get' ? { facts: [entry], suggestions: [] } : entry
    ));
  });

  it('maps every Settings action to its registered native command', async () => {
    await expect(symonMemoryGet()).resolves.toEqual({ facts: [entry], suggestions: [] });
    await symonMemoryAdd('I prefer aisle seats');
    await symonMemoryUpdate(7, 'I prefer aisle seats');
    await symonMemoryForget(7);
    await symonMemoryAcceptSuggestion(9);
    await symonMemoryDismissSuggestion(9);

    expect(tauriInvoke.mock.calls).toEqual([
      ['symon_memory_get', undefined],
      ['symon_memory_add', { fact: 'I prefer aisle seats' }],
      ['symon_memory_update', { id: 7, fact: 'I prefer aisle seats' }],
      ['symon_memory_forget', { id: 7 }],
      ['symon_memory_accept_suggestion', { id: 9 }],
      ['symon_memory_dismiss_suggestion', { id: 9 }],
    ]);
  });
});
