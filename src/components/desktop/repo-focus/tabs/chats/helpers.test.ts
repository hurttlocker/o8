import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatElapsedAgo, historyIsVisibleForRepos } from './helpers';
import type { ChatHistoryItem } from './types';

const conversation: ChatHistoryItem = {
  tabId: 'thoughts-one',
  title: 'New orchestrator',
  preview: 'hey',
  empty: false,
  messageCount: 1,
  model: 'claude-code',
  savedAt: '2026-08-09T12:00:00.000Z',
  modifiedAt: '2026-08-09T12:00:00.000Z',
  starred: false,
  pinned: false,
  repoPath: '/Users/operator',
};

describe('historyIsVisibleForRepos', () => {
  it('keeps conversations visible when the app has no loaded repos', () => {
    expect(historyIsVisibleForRepos(conversation, [])).toBe(true);
  });

  it('preserves repo scoping when a repo is selected', () => {
    expect(historyIsVisibleForRepos(conversation, [{
      id: 'other',
      name: 'other',
      localPath: '/tmp/other',
      remoteUrl: null,
      defaultBranch: 'main',
    }])).toBe(false);
  });
});

describe('compact chat ages', () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    [0, '0m'], [59_000, '0m'], [60_000, '1m'], [59 * 60_000, '59m'],
    [60 * 60_000, '1h'], [23 * 60 * 60_000, '23h'], [24 * 60 * 60_000, '1d'],
    [8 * 24 * 60 * 60_000, '8d'], [-60_000, '0m'],
  ])('renders age %d with only its number and unit', (age, expected) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T16:00:00.000Z'));
    expect(formatElapsedAgo(new Date(Date.now() - age).toISOString())).toBe(expected);
  });
  it('keeps an unavailable age compact', () => {
    expect(formatElapsedAgo('invalid')).toBe('0m');
  });
});
