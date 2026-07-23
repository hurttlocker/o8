import 'server-only';

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export const FREE_TIER_DAILY_LIMIT = 10;

const DATA_DIR = getDataDir();
const DB_PATH = path.join(DATA_DIR, 'chat-usage.db');

let sqlite: Database.Database | null = null;

interface CountRow {
  count: number;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function getUsageDb(): Database.Database {
  if (sqlite) return sqlite;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS chat_usage (
      user_id TEXT NOT NULL,
      date_utc TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date_utc)
    )
  `).run();
  return sqlite;
}

export function getTodayCount(userId: string): number {
  const row = getUsageDb()
    .prepare('SELECT count FROM chat_usage WHERE user_id = ? AND date_utc = ?')
    .get(userId, todayUtc()) as CountRow | undefined;
  return row?.count ?? 0;
}

export function recordChatTurn(userId: string): number {
  const db = getUsageDb();
  const dateUtc = todayUtc();
  db.prepare(`
    INSERT INTO chat_usage (user_id, date_utc, count)
    VALUES (?, ?, 1)
    ON CONFLICT(user_id, date_utc)
    DO UPDATE SET count = count + 1
  `).run(userId, dateUtc);

  const row = db
    .prepare('SELECT count FROM chat_usage WHERE user_id = ? AND date_utc = ?')
    .get(userId, dateUtc) as CountRow | undefined;
  return row?.count ?? 0;
}
