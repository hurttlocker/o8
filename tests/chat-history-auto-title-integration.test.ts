import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE, PATCH, POST } from '@/app/api/v2/chat-history/route';
import { getDataDir } from '@/lib/data-dir-migration';

let tabId: string;
const fetchMock = vi.fn<typeof fetch>();
const pendingResponses: Array<() => void> = [];
const messages = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `message-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: index % 2 === 0 ? 'Explain sorting an array' : 'Use a stable comparison',
  timestamp: index + 1,
}));
const filePath = () => join(getDataDir(), 'chat-history', `${tabId}.json`);
const stored = (): Record<string, unknown> => JSON.parse(readFileSync(filePath(), 'utf8'));
const response = (title: string) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: title } }] }),
}) as Response;
// Drain the promise chain after resolving our in-memory transport; no timed sleep.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function save(body: Record<string, unknown>) {
  const result = await POST(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'POST',
    body: JSON.stringify({ tabId, ...body }),
  }));
  expect(result.status).toBe(200);
}

async function rename(title: string) {
  const result = await PATCH(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'PATCH',
    body: JSON.stringify({ tabId, title }),
  }));
  expect(result.status).toBe(200);
}

beforeEach(() => {
  tabId = `title2530-${randomUUID()}`;
  fetchMock.mockReset().mockImplementation(async () => response('Initial sorting topic'));
  vi.stubEnv('OPENROUTER_API_KEY', 'test-only');
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  for (const finish of pendingResponses.splice(0)) finish();
  await settle();
  await DELETE(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('chat-history auto-title state through real routes (#2530)', () => {
  it('generates at two messages, refreshes once at eight, and ignores repeat saves', async () => {
    fetchMock
      .mockResolvedValueOnce(response('Initial sorting topic'))
      .mockResolvedValueOnce(response('Refined sorting topic'));
    await save({ messages: messages(2) });
    await vi.waitFor(() => expect(stored()).toMatchObject({
      title: 'Initial sorting topic', titleSource: 'llm', autoTitledAtCount: 2,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await save({ messages: messages(8) });
    await vi.waitFor(() => expect(stored()).toMatchObject({
      title: 'Refined sorting topic', titleSource: 'llm', autoTitledAtCount: 8,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await save({ messages: messages(8) });
    await save({ messages: messages(8) });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stored()).toMatchObject({
      title: 'Refined sorting topic', titleSource: 'llm', autoTitledAtCount: 8,
    });
  });

  it('preserves operator metadata and ignores client-spoofed provenance and counters', async () => {
    await save({ messages: messages(2) });
    await vi.waitFor(() => expect(stored().autoTitledAtCount).toBe(2));
    await rename('Operator sorting title');
    await save({ messages: messages(8), titleSource: 'llm', autoTitledAtCount: 0 });
    await settle();
    expect(stored()).toMatchObject({
      title: 'Operator sorting title', titleSource: 'operator', autoTitledAtCount: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps an operator rename when a pending title response completes after another POST', async () => {
    const jsonRead = vi.fn(async () => ({ choices: [{ message: { content: 'Late generated title' } }] }));
    let finish!: () => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finish = () => resolve({ ok: true, json: jsonRead } as unknown as Response);
      pendingResponses.push(finish);
    }));
    await save({ messages: messages(2) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await rename('Operator protected title');
    await save({ messages: messages(3) });
    finish();
    await settle();
    expect(jsonRead).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({ title: 'Operator protected title', titleSource: 'operator' });
    expect(stored().autoTitledAtCount).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores client metadata on a new record with a pre-existing short title', async () => {
    await save({
      messages: messages(2), title: 'Short sorting title',
      titleSource: 'operator', autoTitledAtCount: 999,
    });
    await settle();
    expect(stored()).toMatchObject({ title: 'Short sorting title' });
    expect(stored().titleSource).toBeUndefined();
    expect(stored().autoTitledAtCount).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['code', 0], ['llm', 2], ['operator', 8],
  ])('preserves valid stored metadata %s/%s', async (titleSource, autoTitledAtCount) => {
    await save({ messages: messages(1), title: 'Short sorting title' });
    writeFileSync(filePath(), JSON.stringify({ ...stored(), titleSource, autoTitledAtCount }));
    await save({ messages: messages(1), titleSource: 'spoofed', autoTitledAtCount: 999 });
    expect(stored()).toMatchObject({ titleSource, autoTitledAtCount });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid', 2, undefined, 2],
    [null, 2, undefined, 2],
    ['llm', -1, 'llm', undefined],
    ['code', 1.5, 'code', undefined],
    ['operator', '2', 'operator', undefined],
    ['llm', null, 'llm', undefined],
  ])('normalizes stored metadata %s/%s', async (source, count, expectedSource, expectedCount) => {
    await save({ messages: messages(1), title: 'Short sorting title' });
    writeFileSync(filePath(), JSON.stringify({ ...stored(), titleSource: source, autoTitledAtCount: count }));
    await save({ messages: messages(1) });
    expect(stored().titleSource).toBe(expectedSource);
    expect(stored().autoTitledAtCount).toBe(expectedCount);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
