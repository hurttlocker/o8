import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { DELETE, GET, POST } from '@/app/api/v2/chat-history/route';
import { getDataDir } from '@/lib/data-dir-migration';

const nonce = `${process.pid}-${Math.floor(performance.now())}`;
const pagingTabId = `paging-${nonce}`;
const legacyTabId = `legacy-${nonce}`;
const postIdsTabId = `post-ids-${nonce}`;
const tabIds = [pagingTabId, legacyTabId, postIdsTabId];

const historyDir = join(getDataDir(), 'chat-history');
const historyPath = (tabId: string) => join(historyDir, `${tabId}.json`);

const get = (tabId: string, query = '') => GET(new NextRequest(
  `http://localhost/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}${query}`,
));

const post = (body: Record<string, unknown>) => POST(new NextRequest(
  'http://localhost/api/v2/chat-history',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  },
));

afterAll(async () => {
  await Promise.all(tabIds.map((tabId) => DELETE(new NextRequest(
    `http://localhost/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`,
  ))));
});

describe('chat-history paged GET', () => {
  it('returns the newest tail then immediately older, non-overlapping pages', async () => {
    const messages = Array.from({ length: 7 }, (_, index) => ({
      id: `m${index + 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      timestamp: index + 1,
      content: `message ${index + 1}`,
    }));
    await post({
      tabId: pagingTabId,
      replace: true,
      messages,
      title: 'Paging thread',
      starred: true,
      repoName: 'o8',
    });

    const initialResponse = await get(pagingTabId, '&limit=3');
    expect(initialResponse.status).toBe(200);
    const initial = await initialResponse.json();
    expect(initial.messages.map((message: { id: string }) => message.id)).toEqual(['m5', 'm6', 'm7']);
    expect(initial.page).toMatchObject({ total: 7, hasMore: true });
    expect(initial.page.beforeCursor).toEqual(expect.any(String));
    expect(initial.title).toBe('Paging thread');
    expect(initial.starred).toBe(true);
    expect(initial.repoName).toBe('o8');

    const olderResponse = await get(
      pagingTabId,
      `&limit=3&before=${encodeURIComponent(initial.page.beforeCursor)}`,
    );
    expect(olderResponse.status).toBe(200);
    const older = await olderResponse.json();
    expect(older.messages.map((message: { id: string }) => message.id)).toEqual(['m2', 'm3', 'm4']);
    expect(older.page).toMatchObject({
      revision: initial.page.revision,
      total: 7,
      hasMore: true,
    });
    expect(new Set([
      ...initial.messages.map((message: { id: string }) => message.id),
      ...older.messages.map((message: { id: string }) => message.id),
    ]).size).toBe(6);

    const oldestResponse = await get(
      pagingTabId,
      `&limit=3&before=${encodeURIComponent(older.page.beforeCursor)}`,
    );
    const oldest = await oldestResponse.json();
    expect(oldest.messages.map((message: { id: string }) => message.id)).toEqual(['m1']);
    expect(oldest.page).toMatchObject({ total: 7, hasMore: false, beforeCursor: null });
  });

  it('returns cursor_invalid for malformed and stale cursors', async () => {
    const malformed = await get(pagingTabId, '&limit=2&before=malformed');
    expect(malformed.status).toBe(409);
    expect(await malformed.json()).toMatchObject({
      error: 'cursor_invalid',
      currentRevision: expect.any(String),
    });

    const initial = await (await get(pagingTabId, '&limit=2')).json();
    await post({
      tabId: pagingTabId,
      messages: [{ id: 'm8', role: 'assistant', timestamp: 8, content: 'new message' }],
    });
    const stale = await get(
      pagingTabId,
      `&limit=2&before=${encodeURIComponent(initial.page.beforeCursor)}`,
    );
    expect(stale.status).toBe(409);
    const staleBody = await stale.json();
    expect(staleBody.error).toBe('cursor_invalid');
    expect(staleBody.currentRevision).not.toBe(initial.page.revision);
  });

  it('keeps legacy full GET unpaged while deterministically supplying stable ids', async () => {
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(historyPath(legacyTabId), JSON.stringify({
      messages: [
        { role: 'user', timestamp: 1, content: 'legacy user' },
        { role: 'assistant', timestamp: 2, content: 'legacy assistant' },
      ],
      model: 'codex',
      savedAt: '2026-01-01T00:00:00.000Z',
      starred: false,
      title: 'Legacy thread',
      repoName: 'legacy-repo',
    }));

    const first = await (await get(legacyTabId)).json();
    const second = await (await get(legacyTabId)).json();
    expect(first.messages).toHaveLength(2);
    expect(first.messages.map((message: { id: string }) => message.id)).toEqual(
      second.messages.map((message: { id: string }) => message.id),
    );
    expect(first.messages.every((message: { id?: string }) => typeof message.id === 'string')).toBe(true);
    expect(first).not.toHaveProperty('page');
    expect(first).toMatchObject({ title: 'Legacy thread', repoName: 'legacy-repo', model: 'codex' });
  });

  it('persists assigned ids for id-less POST messages', async () => {
    await post({
      tabId: postIdsTabId,
      replace: true,
      messages: [
        { role: 'user', timestamp: 1, content: 'new user' },
        { role: 'assistant', timestamp: 2, content: 'new assistant' },
      ],
    });

    const persisted = JSON.parse(readFileSync(historyPath(postIdsTabId), 'utf8'));
    expect(persisted.messages).toHaveLength(2);
    expect(persisted.messages.every((message: { id?: string }) => typeof message.id === 'string')).toBe(true);
    const full = await (await get(postIdsTabId)).json();
    expect(full.messages.map((message: { id: string }) => message.id)).toEqual(
      persisted.messages.map((message: { id: string }) => message.id),
    );
    expect(full).not.toHaveProperty('page');
  });
});
