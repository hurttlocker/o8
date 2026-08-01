/**
 * Schema v35 — durable full-text indexes for issue #984 Stage 1.
 *
 * `chat_history_fts` mirrors the existing `chat_history` table, while
 * `transcript_search_documents` stores the normalized runtime transcript text
 * captured at packet completion and `transcript_fts` indexes it. Trigger trios
 * keep both indexes coherent after the one-time backfill.
 */

import type Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { isFts5Available } from '@/lib/db/v14-fts5-migration';

interface ChatHistoryFile {
  messages?: unknown;
  model?: unknown;
  savedAt?: unknown;
  starred?: unknown;
  title?: unknown;
  planText?: unknown;
  repoName?: unknown;
  repoPath?: unknown;
  repoBranch?: unknown;
  remoteUrl?: unknown;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function backfillChatHistoryTable(sqlite: Database.Database): number {
  const historyDir = join(getDataDir(), 'chat-history');
  let files: string[];
  try {
    files = readdirSync(historyDir).filter((file) => file.endsWith('.json'));
  } catch {
    return 0;
  }

  const upsert = sqlite.prepare(`
    INSERT INTO chat_history (
      tab_id, messages_json, model, saved_at, modified_at, starred, title,
      plan_text, repo_name, repo_path, repo_branch, remote_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tab_id) DO UPDATE SET
      messages_json = excluded.messages_json,
      model = excluded.model,
      saved_at = excluded.saved_at,
      modified_at = excluded.modified_at,
      starred = excluded.starred,
      title = excluded.title,
      plan_text = excluded.plan_text,
      repo_name = excluded.repo_name,
      repo_path = excluded.repo_path,
      repo_branch = excluded.repo_branch,
      remote_url = excluded.remote_url
  `);
  let count = 0;
  const apply = sqlite.transaction(() => {
    for (const file of files) {
      try {
        const filePath = join(historyDir, file);
        const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as ChatHistoryFile;
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        if (messages.length === 0) continue;
        const modifiedAt = statSync(filePath).mtime.toISOString();
        upsert.run(
          basename(file, '.json'),
          JSON.stringify(messages),
          textOrNull(parsed.model),
          textOrNull(parsed.savedAt),
          modifiedAt,
          parsed.starred === true ? 1 : 0,
          textOrNull(parsed.title),
          textOrNull(parsed.planText),
          textOrNull(parsed.repoName),
          textOrNull(parsed.repoPath),
          textOrNull(parsed.repoBranch),
          textOrNull(parsed.remoteUrl),
        );
        count += 1;
      } catch {
        // One malformed legacy file must not block the rest of the backfill.
      }
    }
  });
  apply();
  return count;
}

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
  `);

  if (!isFts5Available(sqlite)) {
    console.warn('[db][v35] FTS5 unavailable; unified text-search indexes were skipped.');
    return { applied: false, chatRowsBackfilled: 0 };
  }

  const chatFtsExisted = Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_history_fts'",
  ).get());

  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_history_fts USING fts5(
      tab_id UNINDEXED,
      title,
      repo_name,
      repo_path,
      messages,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS chat_history_fts_ai AFTER INSERT ON chat_history BEGIN
      INSERT INTO chat_history_fts(tab_id, title, repo_name, repo_path, messages)
      VALUES (new.tab_id, COALESCE(new.title, ''), COALESCE(new.repo_name, ''),
        COALESCE(new.repo_path, ''), new.messages_json);
    END;

    CREATE TRIGGER IF NOT EXISTS chat_history_fts_ad AFTER DELETE ON chat_history BEGIN
      DELETE FROM chat_history_fts WHERE tab_id = old.tab_id;
    END;

    CREATE TRIGGER IF NOT EXISTS chat_history_fts_au AFTER UPDATE ON chat_history BEGIN
      DELETE FROM chat_history_fts WHERE tab_id = old.tab_id;
      INSERT INTO chat_history_fts(tab_id, title, repo_name, repo_path, messages)
      VALUES (new.tab_id, COALESCE(new.title, ''), COALESCE(new.repo_name, ''),
        COALESCE(new.repo_path, ''), new.messages_json);
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

  const chatRowsBackfilled = chatFtsExisted ? 0 : backfillChatHistoryTable(sqlite);
  sqlite.exec(`
    INSERT INTO chat_history_fts(tab_id, title, repo_name, repo_path, messages)
    SELECT ch.tab_id, COALESCE(ch.title, ''), COALESCE(ch.repo_name, ''),
      COALESCE(ch.repo_path, ''), ch.messages_json
    FROM chat_history ch
    WHERE NOT EXISTS (
      SELECT 1 FROM chat_history_fts fts WHERE fts.tab_id = ch.tab_id
    );

    INSERT INTO transcript_fts(packet_id, title, transcript_text)
    SELECT doc.packet_id, doc.title, doc.transcript_text
    FROM transcript_search_documents doc
    WHERE NOT EXISTS (
      SELECT 1 FROM transcript_fts fts WHERE fts.packet_id = doc.packet_id
    );
  `);

  if (chatRowsBackfilled > 0) {
    console.log(`[db][v35] Mirrored ${chatRowsBackfilled} chat-history rows into SQLite search.`);
  }
  return { applied: true, chatRowsBackfilled };
}
