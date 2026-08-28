import 'server-only';

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';
import type { SymonTextTranscriptEntry } from '@/lib/mobile/symon-text-session-store';

const MAX_TRANSCRIPT_MESSAGES = 24;
const MAX_TRANSCRIPT_CHARS = 32_000;

export type ManagedSymonTurnStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface ManagedSymonTurn {
  eventId: string;
  conversationId: string;
  providerMessageId: string;
  senderHandle: string;
  recipientHandle: string;
  requestText: string;
  turnId: string;
  sessionId: string | null;
  promptText: string | null;
  executionEpoch: string | null;
  status: ManagedSymonTurnStatus;
  responseText: string | null;
  detail: string | null;
  createdAt: number;
  updatedAt: number;
}

interface TurnRow {
  event_id: string;
  conversation_id: string;
  provider_message_id: string;
  sender_handle: string;
  recipient_handle: string;
  request_text: string;
  turn_id: string;
  session_id: string | null;
  prompt_text: string | null;
  execution_epoch: string | null;
  status: ManagedSymonTurnStatus;
  response_text: string | null;
  detail: string | null;
  created_at: number;
  updated_at: number;
}

interface ConversationRow {
  conversation_id: string;
  session_id: string | null;
  transcript_json: string;
  created_at: number;
  updated_at: number;
}

function toTurn(row: TurnRow): ManagedSymonTurn {
  return {
    eventId: row.event_id,
    conversationId: row.conversation_id,
    providerMessageId: row.provider_message_id,
    senderHandle: row.sender_handle,
    recipientHandle: row.recipient_handle,
    requestText: row.request_text,
    turnId: row.turn_id,
    sessionId: row.session_id,
    promptText: row.prompt_text,
    executionEpoch: row.execution_epoch,
    status: row.status,
    responseText: row.response_text,
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function turnIdFor(eventId: string): string {
  return `managed-${createHash('sha256').update(eventId).digest('hex').slice(0, 32)}`;
}

function transcript(value: string): SymonTextTranscriptEntry[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      return (row.role === 'user' || row.role === 'assistant') && typeof row.text === 'string'
        ? [{ role: row.role, text: row.text }]
        : [];
    });
  } catch {
    return [];
  }
}

function capTranscript(entries: SymonTextTranscriptEntry[]): SymonTextTranscriptEntry[] {
  const capped = entries.slice(-MAX_TRANSCRIPT_MESSAGES);
  let chars = capped.reduce((total, entry) => total + entry.text.length, 0);
  while (capped.length > 1 && chars > MAX_TRANSCRIPT_CHARS) {
    chars -= capped.shift()?.text.length ?? 0;
  }
  return capped;
}

export class ManagedSymonMessagesStore {
  constructor(private readonly sqlite: Database.Database) {}

  getOrCreateTurn(input: {
    eventId: string;
    conversationId: string;
    providerMessageId: string;
    senderHandle: string;
    recipientHandle: string;
    text: string;
    now: number;
  }): ManagedSymonTurn {
    const write = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO managed_symon_conversations (
          conversation_id, session_id, transcript_json, created_at, updated_at
        ) VALUES (?, NULL, '[]', ?, ?)
        ON CONFLICT(conversation_id) DO NOTHING
      `).run(input.conversationId, input.now, input.now);
      this.sqlite.prepare(`
        INSERT INTO managed_symon_turns (
          event_id, conversation_id, provider_message_id, sender_handle,
          recipient_handle, request_text, turn_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
        ON CONFLICT DO NOTHING
      `).run(
        input.eventId,
        input.conversationId,
        input.providerMessageId,
        input.senderHandle,
        input.recipientHandle,
        input.text,
        turnIdFor(input.eventId),
        input.now,
        input.now,
      );
    });
    write();
    const row = this.sqlite.prepare(`
      SELECT * FROM managed_symon_turns WHERE event_id = ?
    `).get(input.eventId) as TurnRow | undefined;
    if (!row) throw new Error('managed Symon turn was not persisted');
    if (
      row.conversation_id !== input.conversationId
      || row.provider_message_id !== input.providerMessageId
    ) {
      throw new Error('managed Symon event identity collision');
    }
    return toTurn(row);
  }

  getConversation(conversationId: string): {
    sessionId: string | null;
    transcript: SymonTextTranscriptEntry[];
  } {
    const row = this.sqlite.prepare(`
      SELECT * FROM managed_symon_conversations WHERE conversation_id = ?
    `).get(conversationId) as ConversationRow | undefined;
    if (!row) throw new Error('managed Symon conversation is missing');
    return { sessionId: row.session_id, transcript: transcript(row.transcript_json) };
  }

  beginExecution(input: {
    eventId: string;
    sessionId: string;
    promptText: string;
    executionEpoch: string;
    now: number;
  }): ManagedSymonTurn {
    this.sqlite.prepare(`
      UPDATE managed_symon_turns
      SET session_id = ?, prompt_text = ?, execution_epoch = ?,
          status = 'processing', updated_at = ?
      WHERE event_id = ? AND status = 'queued'
    `).run(input.sessionId, input.promptText, input.executionEpoch, input.now, input.eventId);
    const row = this.sqlite.prepare('SELECT * FROM managed_symon_turns WHERE event_id = ?')
      .get(input.eventId) as TurnRow | undefined;
    if (!row) throw new Error('managed Symon turn is missing');
    return toTurn(row);
  }

  appendConversation(input: {
    conversationId: string;
    sessionId: string;
    entries: SymonTextTranscriptEntry[];
    now: number;
  }): void {
    const current = this.getConversation(input.conversationId);
    const next = capTranscript([...current.transcript, ...input.entries]);
    this.sqlite.prepare(`
      UPDATE managed_symon_conversations
      SET session_id = ?, transcript_json = ?, updated_at = ?
      WHERE conversation_id = ?
    `).run(input.sessionId, JSON.stringify(next), input.now, input.conversationId);
  }

  complete(eventId: string, responseText: string, now: number): ManagedSymonTurn {
    this.sqlite.prepare(`
      UPDATE managed_symon_turns
      SET status = 'completed', response_text = ?, detail = NULL, updated_at = ?
      WHERE event_id = ?
    `).run(responseText, now, eventId);
    return this.requireTurn(eventId);
  }

  fail(eventId: string, detail: string, now: number): ManagedSymonTurn {
    this.sqlite.prepare(`
      UPDATE managed_symon_turns
      SET status = 'failed', detail = ?, updated_at = ?
      WHERE event_id = ?
    `).run(detail.slice(0, 1_000), now, eventId);
    return this.requireTurn(eventId);
  }

  private requireTurn(eventId: string): ManagedSymonTurn {
    const row = this.sqlite.prepare('SELECT * FROM managed_symon_turns WHERE event_id = ?')
      .get(eventId) as TurnRow | undefined;
    if (!row) throw new Error('managed Symon turn is missing');
    return toTurn(row);
  }
}

let productionStore: ManagedSymonMessagesStore | null = null;

export function getManagedSymonMessagesStore(): ManagedSymonMessagesStore {
  productionStore ??= new ManagedSymonMessagesStore(getSqlite());
  return productionStore;
}
