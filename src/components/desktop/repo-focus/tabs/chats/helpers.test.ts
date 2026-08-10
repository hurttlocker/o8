import { describe, expect, it } from 'vitest';
import { historyIsVisibleForRepos } from './helpers';
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
