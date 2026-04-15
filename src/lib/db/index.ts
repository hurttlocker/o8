/**
 * Database Connection — SQLite via Drizzle ORM
 *
 * Single connection per process (Next.js server).
 * Database file lives at DATA_DIR/cortex-ide.db (defaults to ~/.o8/).
 * Ensures tables on first connection until a schema marker is written.
 *
 * For production multi-tenant: swap better-sqlite3 for @neondatabase/serverless
 * or postgres.js — Drizzle supports both with minimal changes.
 */

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateDataDirOnce } from '@/lib/data-dir-migration';
import { extractApprovalContextIdsFromMetadataJson } from '@/lib/approvals/context';
import * as schema from './schema';
import { migrateLegacyApprovalStoreIfNeeded } from '@/lib/approvals/storage-migration';
import { migrateLegacyLaneStoreIfNeeded } from '@/lib/lane/storage-migration';
import { ensureUsageLogIndexes, ensureUsageLogSchema } from '@/lib/db/usage-log-migration';

// ── Data directory ──

migrateDataDirOnce();

const DATA_DIR = process.env.O8_DATA_DIR
  || process.env.CORTEX_IDE_DATA_DIR
  || path.join(os.homedir(), '.o8');
// Keep the filename as cortex-ide.db so the data dir migration's byte-for-byte
// copy still points at the right file. Renaming the file would require a
// second migration step with no user-facing benefit.
const DB_PATH = process.env.CORTEX_IDE_DB_PATH || path.join(DATA_DIR, 'cortex-ide.db');
// Bump when ensureTables() adds new schema or backfill work.
const DB_SCHEMA_VERSION = 4;
const DB_MIGRATION_MARKER_PATH = path.join(DATA_DIR, `.db-migrated-v${DB_SCHEMA_VERSION}`);

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// ── Singleton connection ──

let _db: BetterSQLite3Database<typeof schema> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sqlite: any = null;

/**
 * Get the database instance. Creates it on first call.
 * Returns null if better-sqlite3 is not available (production bundle issue).
 */
export function getDb(): BetterSQLite3Database<typeof schema> | null {
  if (_db) return _db;
  if (!Database || !drizzle) return null;

  const dbFilePreviouslyExisted = existsSync(DB_PATH);
  _sqlite = new Database(DB_PATH);

  // SQLite performance pragmas
  _sqlite.pragma('journal_mode = WAL');      // Write-ahead logging (concurrent reads)
  _sqlite.pragma('synchronous = NORMAL');    // Faster writes, still crash-safe with WAL
  _sqlite.pragma('busy_timeout = 5000');     // Wait 5s instead of failing on lock
  _sqlite.pragma('cache_size = -20000');     // 20MB page cache
  _sqlite.pragma('foreign_keys = ON');       // Enforce FK constraints

  _db = drizzle!(_sqlite, { schema });

  if (shouldEnsureTables(dbFilePreviouslyExisted)) {
    ensureTables(_sqlite);
    writeMigrationMarker();
  }

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
  const approvalsTablePreviouslyMissing = !sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'`)
    .get();
  const lanesTablePreviouslyMissing = !sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lanes'`)
    .get();

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
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      session_key TEXT,
      repo_path TEXT,
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

    CREATE TABLE IF NOT EXISTS github_installations (
      installation_id INTEGER PRIMARY KEY,
      account_login TEXT NOT NULL,
      account_type TEXT,
      target_type TEXT,
      permissions_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS github_repositories (
      repo_id INTEGER PRIMARY KEY,
      full_name TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      private INTEGER NOT NULL DEFAULT 0,
      default_branch TEXT,
      installation_id INTEGER REFERENCES github_installations(installation_id) ON DELETE SET NULL,
      last_webhook_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS github_sync_state (
      key TEXT PRIMARY KEY,
      repo_full_name TEXT NOT NULL,
      resource TEXT NOT NULL,
      etag TEXT,
      last_synced_at TEXT,
      last_successful_at TEXT,
      last_error TEXT,
      stale_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS github_issues (
      issue_id INTEGER PRIMARY KEY,
      repo_full_name TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      author_login TEXT,
      body TEXT,
      labels_json TEXT NOT NULL DEFAULT '[]',
      assignees_json TEXT NOT NULL DEFAULT '[]',
      comments_count INTEGER NOT NULL DEFAULT 0,
      url TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      closed_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_github_issues_repo_number ON github_issues(repo_full_name, number);

    CREATE TABLE IF NOT EXISTS github_pull_requests (
      pull_request_id INTEGER PRIMARY KEY,
      repo_full_name TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      author_login TEXT,
      body TEXT,
      head_ref_name TEXT,
      base_ref_name TEXT,
      additions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      changed_files INTEGER NOT NULL DEFAULT 0,
      review_decision TEXT,
      status_checks_json TEXT NOT NULL DEFAULT '[]',
      url TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      closed_at TEXT,
      merged_at TEXT
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      runtime TEXT NOT NULL,
      agent TEXT NOT NULL,
      session_key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      summary TEXT NOT NULL,
      tool_name TEXT,
      args_json TEXT,
      command TEXT,
      editable INTEGER,
      diff_json TEXT,
      risk TEXT NOT NULL,
      metadata_json TEXT,
      packet_id TEXT,
      lane_id TEXT,
      policy_rule_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolution_json TEXT,
      audit_json TEXT NOT NULL DEFAULT '[]',
      fingerprint TEXT NOT NULL,
      continuation_json TEXT
    );

    CREATE TABLE IF NOT EXISTS lanes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      worktree_path TEXT,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      runtime TEXT NOT NULL,
      session_key TEXT,
      packet_id TEXT,
      status TEXT NOT NULL,
      ownership TEXT NOT NULL,
      writer_token TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_event_at TEXT,
      last_event_label TEXT
    );

    CREATE TABLE IF NOT EXISTS lane_events (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
      verb TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS external_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      transport TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      env_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_github_prs_repo_number ON github_pull_requests(repo_full_name, number);

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_session_key_created ON approvals(session_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_tool_name ON approvals(tool_name, status);
    CREATE INDEX IF NOT EXISTS idx_approvals_fingerprint_status ON approvals(fingerprint, status);
    CREATE INDEX IF NOT EXISTS idx_approvals_resolved_at ON approvals(resolved_at);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_user_period ON usage_logs(user_id, billing_period);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_github_repositories_installation ON github_repositories(installation_id);
    CREATE INDEX IF NOT EXISTS idx_github_sync_repo_resource ON github_sync_state(repo_full_name, resource);
    CREATE INDEX IF NOT EXISTS idx_github_issues_repo_state_updated ON github_issues(repo_full_name, state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_github_prs_repo_state_updated ON github_pull_requests(repo_full_name, state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_lanes_session_key ON lanes(session_key);
    CREATE INDEX IF NOT EXISTS idx_lanes_packet_id ON lanes(packet_id);
    CREATE INDEX IF NOT EXISTS idx_lanes_repo_branch_status ON lanes(repo_path, branch, status);
    CREATE INDEX IF NOT EXISTS idx_lanes_status ON lanes(status);
    CREATE INDEX IF NOT EXISTS idx_lane_events_lane_timestamp ON lane_events(lane_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_lane_events_timestamp ON lane_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_external_mcp_servers_enabled ON external_mcp_servers(enabled);
    CREATE INDEX IF NOT EXISTS idx_external_mcp_servers_updated_at ON external_mcp_servers(updated_at);

    CREATE TABLE IF NOT EXISTS review_queue (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(status);
    CREATE INDEX IF NOT EXISTS idx_review_queue_lane_id ON review_queue(lane_id);

    CREATE TABLE IF NOT EXISTS watched_agents (
      surface_id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      registered_at INTEGER NOT NULL,
      last_status TEXT NOT NULL DEFAULT 'running',
      retry_count INTEGER NOT NULL DEFAULT 0,
      steer_count INTEGER NOT NULL DEFAULT 0,
      completion_reported INTEGER NOT NULL DEFAULT 0,
      last_event_at INTEGER NOT NULL DEFAULT 0,
      last_activity_at INTEGER NOT NULL
    );
  `);

  ensureApprovalContextColumns(sqlite);
  ensureWatchedAgentColumns(sqlite);
  ensureUsageLogSchema(sqlite);
  ensureApprovalEventsTable(sqlite);
  migrateLegacyApprovalStoreIfNeeded(sqlite, { approvalsTablePreviouslyMissing });
  backfillWatchedAgentColumns(sqlite);
  backfillApprovalContextColumns(sqlite);
  backfillApprovalEventsFromAuditJson(sqlite);
  ensureApprovalContextIndexes(sqlite);
  ensureUsageLogIndexes(sqlite);
  migrateLegacyLaneStoreIfNeeded(sqlite, { lanesTablePreviouslyMissing });
}

function shouldEnsureTables(dbFilePreviouslyExisted: boolean): boolean {
  return !dbFilePreviouslyExisted || !existsSync(DB_MIGRATION_MARKER_PATH);
}

function writeMigrationMarker(): void {
  try {
    writeFileSync(
      DB_MIGRATION_MARKER_PATH,
      JSON.stringify({ schemaVersion: DB_SCHEMA_VERSION, migratedAt: new Date().toISOString() }),
    );
  } catch (error) {
    console.warn(`[db] Failed to write migration marker at ${DB_MIGRATION_MARKER_PATH}`, error);
  }
}

function tableColumnExists(sqlite: Database.Database, tableName: string, columnName: string): boolean {
  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function ensureApprovalContextColumns(sqlite: Database.Database): void {
  if (!tableColumnExists(sqlite, 'approvals', 'packet_id')) {
    sqlite.exec('ALTER TABLE approvals ADD COLUMN packet_id TEXT');
  }
  if (!tableColumnExists(sqlite, 'approvals', 'lane_id')) {
    sqlite.exec('ALTER TABLE approvals ADD COLUMN lane_id TEXT');
  }
  if (!tableColumnExists(sqlite, 'approvals', 'gate_result_json')) {
    sqlite.exec('ALTER TABLE approvals ADD COLUMN gate_result_json TEXT');
  }
  if (!tableColumnExists(sqlite, 'approvals', 'conflict_report_json')) {
    sqlite.exec('ALTER TABLE approvals ADD COLUMN conflict_report_json TEXT');
  }
}

function ensureWatchedAgentColumns(sqlite: Database.Database): void {
  if (!tableColumnExists(sqlite, 'watched_agents', 'last_event_at')) {
    sqlite.exec('ALTER TABLE watched_agents ADD COLUMN last_event_at INTEGER NOT NULL DEFAULT 0');
  }
}

function backfillWatchedAgentColumns(sqlite: Database.Database): void {
  const result = sqlite.prepare(`
    UPDATE watched_agents
    SET last_event_at = CASE
      WHEN last_event_at IS NOT NULL AND last_event_at > 0 THEN last_event_at
      WHEN last_activity_at IS NOT NULL AND last_activity_at > 0 THEN last_activity_at
      ELSE registered_at
    END
    WHERE last_event_at IS NULL OR last_event_at <= 0
  `).run() as { changes?: number };

  if ((result.changes ?? 0) > 0) {
    console.log(`[db] Backfilled last_event_at for ${result.changes} watched agent row${result.changes === 1 ? '' : 's'}`);
  }
}

function backfillApprovalContextColumns(sqlite: Database.Database): void {
  const approvalsNeedingBackfill = sqlite.prepare(`
    SELECT id, metadata_json, packet_id, lane_id
    FROM approvals
    WHERE packet_id IS NULL OR lane_id IS NULL
  `).all() as Array<{
    id: string;
    metadata_json: string | null;
    packet_id: string | null;
    lane_id: string | null;
  }>;

  if (approvalsNeedingBackfill.length === 0) {
    return;
  }

  const updateApprovalContext = sqlite.prepare(`
    UPDATE approvals
    SET packet_id = ?, lane_id = ?
    WHERE id = ?
  `);

  let updatedCount = 0;
  sqlite.transaction((rows: typeof approvalsNeedingBackfill) => {
    for (const row of rows) {
      const { packetId, laneId } = extractApprovalContextIdsFromMetadataJson(row.metadata_json);
      const nextPacketId = row.packet_id ?? packetId;
      const nextLaneId = row.lane_id ?? laneId;

      if (nextPacketId === row.packet_id && nextLaneId === row.lane_id) {
        continue;
      }

      updateApprovalContext.run(nextPacketId ?? null, nextLaneId ?? null, row.id);
      updatedCount += 1;
    }
  })(approvalsNeedingBackfill);

  if (updatedCount > 0) {
    console.log(`[db] Backfilled approval context columns for ${updatedCount} approval rows`);
  }
}

function ensureApprovalEventsTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS approval_events (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      note TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approval_events_approval_timestamp
      ON approval_events(approval_id, timestamp);
  `);
}

function backfillApprovalEventsFromAuditJson(sqlite: Database.Database): void {
  // Check if we've already backfilled by looking for any rows
  const existing = sqlite.prepare('SELECT COUNT(*) as count FROM approval_events').get() as { count: number };
  if (existing.count > 0) return;

  const rows = sqlite.prepare(`
    SELECT id, audit_json FROM approvals WHERE audit_json IS NOT NULL AND audit_json != '[]'
  `).all() as Array<{ id: string; audit_json: string }>;

  if (rows.length === 0) return;

  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO approval_events (id, approval_id, event_type, actor, note, details_json, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let eventCount = 0;
  sqlite.transaction((allRows: typeof rows) => {
    for (const row of allRows) {
      let events: Array<{ type?: string; actor?: string; note?: string; timestamp?: number; [key: string]: unknown }> = [];
      try { events = JSON.parse(row.audit_json); } catch { continue; }
      if (!Array.isArray(events)) continue;

      for (const event of events) {
        const eventId = `evt-${row.id}-${event.timestamp ?? Date.now()}-${eventCount}`;
        const { type: _type, actor: _actor, note: _note, timestamp: _ts, ...rest } = event;
        insert.run(
          eventId,
          row.id,
          event.type ?? 'unknown',
          event.actor ?? 'system',
          event.note ?? null,
          JSON.stringify(rest),
          event.timestamp ?? Date.now(),
        );
        eventCount += 1;
      }
    }
  })(rows);

  if (eventCount > 0) {
    console.log(`[db] Backfilled ${eventCount} approval events from audit_json blobs`);
  }
}

function ensureApprovalContextIndexes(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_approvals_packet_id ON approvals(packet_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_lane_id ON approvals(lane_id);
  `);
}

// Re-export schema for convenience
export * from './schema';
export { schema };
