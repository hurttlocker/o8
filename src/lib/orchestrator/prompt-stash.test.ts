/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROMPT_STASH_LIMIT,
  PROMPT_STASH_STORAGE_KEY,
  listPromptStash,
  popPromptStash,
  stashPrompt,
} from './prompt-stash';

describe('prompt stash storage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('stashes, lists newest first, and pops an entry with its context intact', () => {
    const first = stashPrompt({
      text: 'Review the current composer behavior',
      repoPath: '~',
      threadId: null,
    });
    vi.setSystemTime(new Date('2026-07-29T12:01:00.000Z'));
    const second = stashPrompt({
      text: 'Ship the prompt stash',
      repoPath: '/Users/operator/o8',
      threadId: 'thread-2',
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) throw new Error('expected prompt stash writes to succeed');

    expect(listPromptStash()).toEqual([second, first]);
    expect(second).toMatchObject({
      text: 'Ship the prompt stash',
      repoPath: '/Users/operator/o8',
      threadId: 'thread-2',
      createdAt: Date.parse('2026-07-29T12:01:00.000Z'),
    });

    expect(popPromptStash(second.id)).toEqual(second);
    expect(listPromptStash()).toEqual([first]);
  });

  it('caps the durable list at 50 entries', () => {
    for (let index = 0; index < PROMPT_STASH_LIMIT + 5; index += 1) {
      stashPrompt({
        text: `Prompt ${index}`,
        repoPath: '~',
        threadId: `thread-${index}`,
      });
    }

    const entries = listPromptStash();
    expect(entries).toHaveLength(PROMPT_STASH_LIMIT);
    expect(entries[0]?.text).toBe('Prompt 54');
    expect(entries.at(-1)?.text).toBe('Prompt 5');
  });

  it('recovers from corrupt JSON and accepts the next stash', () => {
    localStorage.setItem(PROMPT_STASH_STORAGE_KEY, '{not-json');

    expect(listPromptStash()).toEqual([]);
    expect(localStorage.getItem(PROMPT_STASH_STORAGE_KEY)).toBeNull();

    const recovered = stashPrompt({
      text: 'Recovered prompt',
      repoPath: '~',
      threadId: null,
    });
    expect(recovered).not.toBeNull();
    expect(listPromptStash()).toEqual([recovered]);
  });
});
