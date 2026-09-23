import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureV56ManagedSymonMessagesSchema } from '@/lib/db/v56-managed-symon-messages-migration';
import { ManagedSymonMessagesStore } from '@/lib/symon/managed-messages-store';

const h = vi.hoisted(() => ({ store: null as unknown, generateShared: vi.fn(), readPlanner: vi.fn(), pollTurn: vi.fn() }));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/symon/managed-messages-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/symon/managed-messages-store')>(),
  getManagedSymonMessagesStore: () => h.store,
}));
vi.mock('@/lib/chat/gateway-client', () => ({ generateSharedSymonText: h.generateShared }));
vi.mock('@/lib/mobile/symon-text-bridge-client', () => ({
  readSymonTextPlannerInfo: h.readPlanner,
  pollSymonTextTurn: h.pollTurn,
}));

import { POST } from './route';

let sqlite: Database.Database;
let store: ManagedSymonMessagesStore;

beforeEach(() => {
  sqlite = new Database(':memory:');
  ensureV56ManagedSymonMessagesSchema(sqlite);
  store = new ManagedSymonMessagesStore(sqlite);
  h.store = store;
  h.generateShared.mockReset().mockResolvedValue('The date is a working plan.');
  h.readPlanner.mockReset();
  h.pollTurn.mockReset();
});

afterEach(() => sqlite.close());

function request() {
  return new NextRequest('http://localhost/api/symon/managed-messages/inbound', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventId: 'imessage:message-1',
      conversationId: 'shared-imessage:group-1',
      messageId: 'message-1',
      sender: '+15555550102',
      recipient: 'imessage',
      text: 'Is the date booked?',
      context: 'Current state: the date is tentative.',
    }),
  });
}

it('persists a shared reply through the route and never invokes a native planner', async () => {
  const first = await POST(request());
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, state: 'done', text: 'The date is a working plan.' });
  expect(h.readPlanner).not.toHaveBeenCalled();
  expect(h.pollTurn).not.toHaveBeenCalled();
  expect(store.getConversation('shared-imessage:group-1').transcript).toEqual([
    { role: 'user', text: expect.stringContaining('Is the date booked?') },
    { role: 'assistant', text: 'The date is a working plan.' },
  ]);

  const replay = await POST(request());
  expect(await replay.json()).toEqual({ ok: true, state: 'done', text: 'The date is a working plan.' });
  expect(h.generateShared).toHaveBeenCalledTimes(1);
  expect(sqlite.prepare('SELECT COUNT(*) AS count FROM managed_symon_turns').get()).toEqual({ count: 1 });
});
