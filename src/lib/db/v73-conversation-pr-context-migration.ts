import type Database from 'better-sqlite3';

export function ensureV73ConversationPrContextSchema(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    const columns = sqlite.prepare('PRAGMA table_info(github_pull_requests)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'repository_id')) {
      // Legacy rows remain unknown until fresh provider evidence supplies an immutable ID.
      sqlite.exec('ALTER TABLE github_pull_requests ADD COLUMN repository_id INTEGER');
    }
    sqlite.exec(`
    CREATE TABLE IF NOT EXISTS conversation_pr_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      host TEXT NOT NULL CHECK (host = 'github.com'),
      repository_id INTEGER NOT NULL CHECK (repository_id > 0),
      pull_request_id INTEGER NOT NULL CHECK (pull_request_id > 0),
      number INTEGER NOT NULL CHECK (number > 0),
      repository_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'context'),
      source TEXT NOT NULL CHECK (source = 'operator'),
      created_at TEXT NOT NULL,
      UNIQUE (thread_id, host, repository_id, pull_request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_pr_context_forward
      ON conversation_pr_context(thread_id, id);
    CREATE INDEX IF NOT EXISTS idx_conversation_pr_context_reverse
      ON conversation_pr_context(host, repository_id, pull_request_id, number, id);
    `);
  }).immediate();
}
