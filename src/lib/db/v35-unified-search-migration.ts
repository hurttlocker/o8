/**
 * Schema v35 — durable full-text indexes for issue #984 Stage 1.
 *
 * Schema setup stays synchronous and cheap. Legacy chat files and completed
 * packet transcripts are ingested by the deferred, resumable worker in
 * `search/backfill`; startup never scans the history directory.
 */

import type Database from 'better-sqlite3';
import { isFts5Available } from '@/lib/db/v14-fts5-migration';

export function ensureV35UnifiedSearchSchema(sqlite: Database.Database): {
  applied: boolean;
  chatRowsBackfilled: number;
} {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS transcript_search_documents (
      packet_id TEXT PRIMARY KEY,
      lane_id TEXT,
      session_key TEXT,
      title TEXT NOT NULL,
      repo_path TEXT,
      runtime TEXT,
      transcript_text TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_search_lane_id
      ON transcript_search_documents(lane_id);
    CREATE INDEX IF NOT EXISTS idx_transcript_search_session_key
      ON transcript_search_documents(session_key);
    CREATE INDEX IF NOT EXISTS idx_transcript_search_completed_at
      ON transcript_search_documents(completed_at DESC);

    CREATE TABLE IF NOT EXISTS search_backfill_state (
      name TEXT PRIMARY KEY,
      cursor TEXT NOT NULL DEFAULT '',
      processed_count INTEGER NOT NULL DEFAULT 0,
      pass_count INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  if (!isFts5Available(sqlite)) {
    console.warn('[search] FTS5 unavailable; unified search indexes were skipped');
    return { applied: false, chatRowsBackfilled: 0 };
  }

  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_history_fts USING fts5(
      tab_id UNINDEXED,
      title,
      repo_name,
      repo_path,
      message_text,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS chat_history_fts_ai AFTER INSERT ON chat_history BEGIN
      INSERT INTO chat_history_fts(tab_id, title, repo_name, repo_path, message_text)
      VALUES (
        new.tab_id,
        COALESCE(new.title, ''),
        COALESCE(new.repo_name, ''),
        COALESCE(new.repo_path, ''),
        COALESCE((
          SELECT group_concat(json_extract(entry.value, '$.content'), char(10))
          FROM json_each(new.messages_json) AS entry
          WHERE json_type(entry.value, '$.content') = 'text'
        ), '')
      );
    END;

    CREATE TRIGGER IF NOT EXISTS chat_history_fts_ad AFTER DELETE ON chat_history BEGIN
      DELETE FROM chat_history_fts WHERE tab_id = old.tab_id;
    END;

    CREATE TRIGGER IF NOT EXISTS chat_history_fts_au AFTER UPDATE ON chat_history BEGIN
      DELETE FROM chat_history_fts WHERE tab_id = old.tab_id;
      INSERT INTO chat_history_fts(tab_id, title, repo_name, repo_path, message_text)
      VALUES (
        new.tab_id,
        COALESCE(new.title, ''),
        COALESCE(new.repo_name, ''),
        COALESCE(new.repo_path, ''),
        COALESCE((
          SELECT group_concat(json_extract(entry.value, '$.content'), char(10))
          FROM json_each(new.messages_json) AS entry
          WHERE json_type(entry.value, '$.content') = 'text'
        ), '')
      );
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
      packet_id UNINDEXED,
      title,
      transcript_text,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS transcript_fts_ai AFTER INSERT ON transcript_search_documents BEGIN
      INSERT INTO transcript_fts(packet_id, title, transcript_text)
      VALUES (new.packet_id, new.title, new.transcript_text);
    END;

    CREATE TRIGGER IF NOT EXISTS transcript_fts_ad AFTER DELETE ON transcript_search_documents BEGIN
      DELETE FROM transcript_fts WHERE packet_id = old.packet_id;
    END;

    CREATE TRIGGER IF NOT EXISTS transcript_fts_au AFTER UPDATE ON transcript_search_documents BEGIN
      DELETE FROM transcript_fts WHERE packet_id = old.packet_id;
      INSERT INTO transcript_fts(packet_id, title, transcript_text)
      VALUES (new.packet_id, new.title, new.transcript_text);
    END;
  `);

  return { applied: true, chatRowsBackfilled: 0 };
}
