import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';

/** Read in each process; a committed forget must invalidate exact and semantic caches. */
export function readMemoryRevision(): string {
  try {
    const db = getSqlite();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_forget_revision'").get()) return '0';
    return (db.prepare('SELECT revision FROM memory_forget_revision WHERE singleton = 1').get() as { revision: string } | undefined)?.revision ?? '0';
  } catch {
    // Unavailable storage cannot justify replaying a previously cached answer.
    return randomUUID();
  }
}

/** Called inside the same SQLite transaction as the source/index deletion. */
export function advanceMemoryRevision(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS memory_forget_revision (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision TEXT NOT NULL)');
  db.prepare('INSERT OR REPLACE INTO memory_forget_revision (singleton, revision) VALUES (1, ?)').run(randomUUID());
}
