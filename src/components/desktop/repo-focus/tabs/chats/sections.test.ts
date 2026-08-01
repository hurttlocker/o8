import { describe, expect, it } from 'vitest';
import {
  attentionBand,
  attentionRank,
  deriveHistoryDateGroups,
  derivePrioritySplit,
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

  it('orders priority rows by rank, then recency', () => {
    const items = [
      { id: 'review-new', status: 'awaiting_review', modifiedAt: '2026-07-31T12:00:00.000Z' },
      { id: 'failed-old', status: 'failed', modifiedAt: '2026-07-29T12:00:00.000Z' },
      { id: 'review-old', status: 'awaiting_review', modifiedAt: '2026-07-30T12:00:00.000Z' },
      { id: 'neutral', status: 'completed', modifiedAt: '2026-07-31T13:00:00.000Z' },
    ];

    const split = derivePrioritySplit(items);
    expect(split.priority.map((item) => item.id)).toEqual(['failed-old', 'review-new', 'review-old']);
    expect(split.remainder.map((item) => item.id)).toEqual(['neutral']);
  });

  it('returns an empty priority section when nothing needs attention', () => {
    const split = derivePrioritySplit([
      { id: 'running', status: 'running', modifiedAt: '2026-07-31T12:00:00.000Z' },
      { id: 'done', status: 'completed', modifiedAt: '2026-07-30T12:00:00.000Z' },
    ]);

    expect(split.priority).toEqual([]);
    expect(split.remainder.map((item) => item.id)).toEqual(['running', 'done']);
  });

  it('does not duplicate priority rows in date groups', () => {
    const split = derivePrioritySplit([
      { ...thread({ tabId: 'failed', modifiedAt: '2026-07-31T12:00:00.000Z' }), status: 'failed' },
      { ...thread({ tabId: 'today', modifiedAt: '2026-07-31T10:00:00.000Z' }), status: 'running' },
      { ...thread({ tabId: 'yesterday', modifiedAt: '2026-07-30T10:00:00.000Z' }), status: 'completed' },
    ]);
    const dateIds = deriveHistoryDateGroups(split.remainder, new Date('2026-07-31T15:00:00.000Z'))
      .flatMap((group) => group.items.map((item) => item.tabId));

    expect(split.priority.map((item) => item.tabId)).toEqual(['failed']);
    expect(dateIds).toEqual(['today', 'yesterday']);
    expect(new Set([...split.priority.map((item) => item.tabId), ...dateIds]).size).toBe(3);
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
