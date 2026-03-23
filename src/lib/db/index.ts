/**
 * Database Connection — SQLite via Drizzle ORM
 *
 * Single connection per process (Next.js server).
 * Database file lives at DATA_DIR/cortex-ide.db (defaults to ~/.cortex-ide/).
 * Auto-creates tables on first connection via push schema.
 *
 * For production multi-tenant: swap better-sqlite3 for @neondatabase/serverless
 * or postgres.js — Drizzle supports both with minimal changes.
 */

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as schema from './schema';

// ── Data directory ──

const DATA_DIR = process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.cortex-ide');
const DB_PATH = process.env.CORTEX_IDE_DB_PATH || path.join(DATA_DIR, 'cortex-ide.db');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// ── Singleton connection ──

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: InstanceType<typeof import('better-sqlite3').default> | null = null;

/**
 * Get the database instance. Creates it on first call.
 * Returns null if better-sqlite3 is not available (production bundle issue).
 */
export function getDb(): BetterSQLite3Database<typeof schema> | null {
  if (_db) return _db;
  if (!Database || !drizzle) return null;

  _sqlite = new Database(DB_PATH);

  // SQLite performance pragmas
  _sqlite.pragma('journal_mode = WAL');      // Write-ahead logging (concurrent reads)
  _sqlite.pragma('synchronous = NORMAL');    // Faster writes, still crash-safe with WAL
  _sqlite.pragma('busy_timeout = 5000');     // Wait 5s instead of failing on lock
  _sqlite.pragma('cache_size = -20000');     // 20MB page cache
  _sqlite.pragma('foreign_keys = ON');       // Enforce FK constraints

  _db = drizzle!(_sqlite, { schema });

  // Auto-create tables
  ensureTables(_sqlite);

  console.log(`[db] Connected to ${DB_PATH}`);
  return _db;
}

/**
 * Get the raw SQLite instance (for transactions, pragmas, etc).
 */
export function getSqlite(): Database.Database {
  if (!_sqlite) getDb();
  return _sqlite!;
}

/**
 * Close the database connection (for graceful shutdown).
 */
export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
    console.log('[db] Connection closed');
  }
}

/**
 * Get the database file path.
 */
export function getDbPath(): string {
  return DB_PATH;
}

// ── Table creation ──

/**
 * Create tables if they don't exist.
 * Uses raw SQL instead of Drizzle migrations for simplicity in v1.
 * When we move to PostgreSQL, we'll use proper migrations.
 */
function ensureTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_id INTEGER UNIQUE,
      discord_id TEXT UNIQUE,
      email TEXT UNIQUE,
      name TEXT,
      avatar_url TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      token_budget_usd REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      label TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      session_key TEXT,
      agent_name TEXT,
      request_type TEXT DEFAULT 'chat',
      billing_period TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      stripe_customer_id TEXT UNIQUE,
      stripe_subscription_id TEXT UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'active',
      current_period_end TEXT,
      cancel_at_period_end INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      user_agent TEXT,
      ip_address TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      slug TEXT UNIQUE,
      token_budget_usd REAL,
      max_seats INTEGER DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS waitlist (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      github_username TEXT,
      source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_usage_logs_user_period ON usage_logs(user_id, billing_period);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
  `);
}

// Re-export schema for convenience
export * from './schema';
export { schema };
