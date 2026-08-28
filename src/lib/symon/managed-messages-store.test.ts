import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureV56ManagedSymonMessagesSchema } from '@/lib/db/v56-managed-symon-messages-migration';
import { ManagedSymonMessagesStore } from '@/lib/symon/managed-messages-store';

describe('managed Symon Messages store', () => {
  it('deduplicates provider delivery and keeps terminal output readable', () => {
    const sqlite = new Database(':memory:');
    try {
      ensureV56ManagedSymonMessagesSchema(sqlite);
      const store = new ManagedSymonMessagesStore(sqlite);
      const input = {
        eventId: 'event-1',
        conversationId: 'chat-1',
        providerMessageId: 'message-1',
        senderHandle: '+12675550111',
        recipientHandle: '+12545550111',
        text: 'What is running?',
        now: 1_000,
      };
      const first = store.getOrCreateTurn(input);
      const duplicate = store.getOrCreateTurn({ ...input, now: 2_000 });
      expect(duplicate.eventId).toBe(first.eventId);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM managed_symon_turns').get())
        .toEqual({ count: 1 });

      const processing = store.beginExecution({
        eventId: first.eventId,
        sessionId: 'session-1',
        promptText: 'User: What is running?',
        executionEpoch: 'process-1',
        now: 3_000,
      });
      expect(processing.status).toBe('processing');
      store.appendConversation({
        conversationId: first.conversationId,
        sessionId: 'session-1',
        entries: [{ role: 'user', text: first.requestText }],
        now: 3_000,
      });
      const completed = store.complete(first.eventId, 'Nothing is blocked.', 4_000);
      expect(completed).toMatchObject({
        status: 'completed',
        responseText: 'Nothing is blocked.',
        executionEpoch: 'process-1',
      });
      expect(store.getConversation(first.conversationId).transcript).toEqual([
        { role: 'user', text: 'What is running?' },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('rejects one event id being rebound to another provider message', () => {
    const sqlite = new Database(':memory:');
    try {
      ensureV56ManagedSymonMessagesSchema(sqlite);
      const store = new ManagedSymonMessagesStore(sqlite);
      const base = {
        eventId: 'event-1',
        conversationId: 'chat-1',
        providerMessageId: 'message-1',
        senderHandle: '+12675550111',
        recipientHandle: '+12545550111',
        text: 'hello',
        now: 1_000,
      };
      store.getOrCreateTurn(base);
      expect(() => store.getOrCreateTurn({ ...base, providerMessageId: 'message-2' }))
        .toThrow('identity collision');
    } finally {
      sqlite.close();
    }
  });
});
