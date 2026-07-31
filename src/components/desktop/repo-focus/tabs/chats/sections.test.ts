import { describe, expect, it } from 'vitest';
import {
  attentionBand,
  attentionRank,
  deriveSweptThreads,
  isCompletionUnread,
  shouldRecede,
} from './sections';
import { getLastVisited, type RowReadStorage } from './read-state';
import type { ChatHistoryItem } from './types';

function thread(overrides: Partial<ChatHistoryItem> = {}): ChatHistoryItem {
  return {
    tabId: 'thoughts-1',
    title: 'New chat',
    preview: '',
    empty: true,
    messageCount: 0,
    model: 'o8',
    savedAt: '2026-07-20T00:00:00.000Z',
    modifiedAt: '2026-07-20T00:00:00.000Z',
    starred: false,
    pinned: false,
    ...overrides,
  };
}

describe('sidebar section derivation', () => {
  it('orders attention bands by operator urgency', () => {
    const ranks = [
      attentionRank({ status: 'failed' }),
      attentionRank({ status: 'reviewing', rejected: true }),
      attentionRank({ status: 'awaiting_human' }),
      attentionRank({ status: 'awaiting_review' }),
      attentionRank({ status: 'merged', unread: true }),
    ];
    expect(ranks).toEqual([5, 4, 3, 2, 1]);
  });

  it('recedes awaiting_orchestrator unless the row is active or hovered', () => {
    const band = attentionBand({ status: 'awaiting_orchestrator' });
    expect(band).toBe('in-flight');
    expect(shouldRecede({ band, active: false, hovered: false })).toBe(true);
    expect(shouldRecede({ band, active: true, hovered: false })).toBe(false);
  });

  it('sweeps only stale disposable threads without mutating pinned or active rows', () => {
    const now = Date.parse('2026-07-31T12:00:00.000Z');
    const stale = thread();
    const pinned = thread({ tabId: 'thoughts-pinned', pinned: true });
    const active = thread({ tabId: 'thoughts-active' });
    const result = deriveSweptThreads([stale, pinned, active], {
      activeSessionKey: 'thoughts-active',
      now,
    });

    expect(result.swept.map((item) => item.tabId)).toEqual(['thoughts-1']);
    expect(result.chats.map((item) => item.tabId)).toEqual(['thoughts-pinned', 'thoughts-active']);
    expect(pinned.archivedAt).toBeUndefined();
    expect(active.archivedAt).toBeUndefined();
  });

  it('treats an empty read-state map as zero unread rows', () => {
    const storage: RowReadStorage = {
      getItem: () => '{}',
      setItem: () => {},
    };
    const lastVisited = getLastVisited('packet:p1', storage);
    expect(lastVisited).toBeNull();
    expect(isCompletionUnread('2026-07-31T12:00:00.000Z', lastVisited)).toBe(false);
  });
});
