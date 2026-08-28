import type Database from 'better-sqlite3';

/** Schema v56: durable local conversation and turn receipts for managed Symon Messages. */
export function ensureV56ManagedSymonMessagesSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS managed_symon_conversations (
      conversation_id TEXT PRIMARY KEY,
      session_id TEXT,
      transcript_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS managed_symon_turns (
      event_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      sender_handle TEXT NOT NULL,
      recipient_handle TEXT NOT NULL,
      request_text TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      session_id TEXT,
      prompt_text TEXT,
      execution_epoch TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      response_text TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
      FOREIGN KEY (conversation_id) REFERENCES managed_symon_conversations(conversation_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_symon_provider_message
      ON managed_symon_turns(provider_message_id);
    CREATE INDEX IF NOT EXISTS idx_managed_symon_turn_status
      ON managed_symon_turns(status, updated_at);
  `);
}
