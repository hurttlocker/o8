import { describe, expect, it } from 'vitest';
import {
  chatHistoryRevision,
  ensureStableChatMessageIds,
  pageChatHistoryMessages,
  parseChatHistoryPageRequest,
} from './chat-history-pagination';

const messages = Array.from({ length: 7 }, (_, index) => ({
  id: `m${index + 1}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `message ${index + 1}`,
}));

describe('chat-history pagination', () => {
  it('uses paging only when requested and clamps its limit', () => {
    expect(parseChatHistoryPageRequest(null, null)).toBeNull();
    expect(parseChatHistoryPageRequest('0', null)?.limit).toBe(1);
    expect(parseChatHistoryPageRequest('999', null)?.limit).toBe(200);
    expect(parseChatHistoryPageRequest(null, 'cursor')?.limit).toBe(50);
  });

  it('returns newest-first pages without changing chronological order or overlap', () => {
    const revision = chatHistoryRevision({ messages, title: 'Thread' });
    const initial = pageChatHistoryMessages(messages, { limit: 3, before: null }, revision);
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error('expected initial page');
    expect(initial.messages.map((message) => message.id)).toEqual(['m5', 'm6', 'm7']);
    expect(initial.page).toMatchObject({ total: 7, hasMore: true });

    const older = pageChatHistoryMessages(
      messages,
      { limit: 3, before: initial.page.beforeCursor },
      revision,
    );
    expect(older.ok).toBe(true);
    if (!older.ok) throw new Error('expected older page');
    expect(older.messages.map((message) => message.id)).toEqual(['m2', 'm3', 'm4']);
    expect(older.page.hasMore).toBe(true);
    expect(new Set([...initial.messages, ...older.messages].map((message) => message.id)).size).toBe(6);
  });

  it('preserves existing ids and derives deterministic ids for legacy rows', () => {
    const legacy = [
      { id: 'client-id', role: 'user', content: 'kept' },
      { role: 'assistant', content: 'same' },
      { role: 'assistant', content: 'same' },
    ];
    const first = ensureStableChatMessageIds(legacy);
    const second = ensureStableChatMessageIds(legacy);
    expect(first.map((message) => message.id)).toEqual(second.map((message) => message.id));
    expect(first[0].id).toBe('client-id');
    expect(first[1].id).not.toBe(first[2].id);
  });

  it('rejects stale and malformed cursors with the current revision', () => {
    const revision = chatHistoryRevision({ messages });
    const initial = pageChatHistoryMessages(messages, { limit: 2, before: null }, revision);
    if (!initial.ok) throw new Error('expected initial page');

    const stale = pageChatHistoryMessages(
      [...messages, { id: 'm8', role: 'assistant', content: 'new' }],
      { limit: 2, before: initial.page.beforeCursor },
      'new-revision',
    );
    expect(stale).toEqual({ ok: false, error: 'cursor_invalid', currentRevision: 'new-revision' });
    expect(pageChatHistoryMessages(messages, { limit: 2, before: 'not-a-cursor' }, revision)).toEqual({
      ok: false,
      error: 'cursor_invalid',
      currentRevision: revision,
    });
  });

  it('keeps revisions stable across savedAt-only writes', () => {
    expect(chatHistoryRevision({ messages, savedAt: '2026-01-01T00:00:00Z' })).toBe(
      chatHistoryRevision({ messages, savedAt: '2026-01-02T00:00:00Z' }),
    );
    expect(chatHistoryRevision({ messages })).not.toBe(
      chatHistoryRevision({ messages: [...messages, { id: 'm8', content: 'changed' }] }),
    );
  });
});
