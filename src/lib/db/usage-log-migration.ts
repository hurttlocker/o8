import type Database from 'better-sqlite3';

const LOG_PREFIX = '[cost-persistence]';

type ColumnInfo = {
  name: string;
  notnull: number;
};

function readTableColumns(sqlite: Database.Database, tableName: string): ColumnInfo[] {
  return sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as ColumnInfo[];
}

export function ensureUsageLogSchema(sqlite: Database.Database): void {
  const columns = readTableColumns(sqlite, 'usage_logs');
  if (columns.length === 0) {
    return;
  }

  const userId = columns.find((column) => column.name === 'user_id');
  const hasRepoPath = columns.some((column) => column.name === 'repo_path');
  if (!userId?.notnull && hasRepoPath) {
    return;
  }

  const repoPathSelect = hasRepoPath ? 'repo_path' : 'NULL';
  const foreignKeysEnabled = Number(sqlite.pragma('foreign_keys', { simple: true }) ?? 1) !== 0;

  if (foreignKeysEnabled) {
    sqlite.pragma('foreign_keys = OFF');
  }

  try {
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE usage_logs__new (
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
          lane_id TEXT,
          packet_id TEXT,
          mission_id TEXT,
          role TEXT,
          attempt INTEGER NOT NULL DEFAULT 1,
          run_id TEXT,
          metadata_json TEXT,
          repo_path TEXT,
          agent_name TEXT,
          request_type TEXT DEFAULT 'chat',
          billing_period TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO usage_logs__new (
          id,
          user_id,
          model,
          provider,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          cache_write_tokens,
          cost_usd,
          session_key,
          repo_path,
          agent_name,
          request_type,
          billing_period,
          created_at
        )
        SELECT
          id,
          user_id,
          model,
          provider,
          COALESCE(input_tokens, 0),
          COALESCE(output_tokens, 0),
          COALESCE(cache_read_tokens, 0),
          COALESCE(cache_write_tokens, 0),
          COALESCE(cost_usd, 0),
          session_key,
          ${repoPathSelect},
          agent_name,
          COALESCE(request_type, 'chat'),
          COALESCE(billing_period, strftime('%Y-%m', 'now')),
          created_at
        FROM usage_logs;

        DROP TABLE usage_logs;
        ALTER TABLE usage_logs__new RENAME TO usage_logs;
      `);
    })();

    console.log(`${LOG_PREFIX} Migrated usage_logs for runtime session persistence.`);
  } finally {
    if (foreignKeysEnabled) {
      sqlite.pragma('foreign_keys = ON');
    }
  }
}

export function ensureUsageLogIndexes(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_usage_logs_user_period ON usage_logs(user_id, billing_period);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_session_key ON usage_logs(session_key);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_packet_attempt ON usage_logs(packet_id, attempt);
  `);
}
