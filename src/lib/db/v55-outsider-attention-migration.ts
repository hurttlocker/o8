import type Database from 'better-sqlite3';

const ATTENTION_COLUMNS = [
  'last_human_comment_author_login',
  'last_human_comment_author_association',
  'last_human_comment_at',
  'last_insider_comment_at',
] as const;

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

function ensureNullableTextColumn(
  sqlite: Database.Database,
  table: 'github_issues' | 'github_pull_requests',
  column: typeof ATTENTION_COLUMNS[number],
): void {
  if (columnExists(sqlite, table, column)) return;
  try {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  } catch (error) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
    throw error;
  }
}

/** Schema v55: minimal per-thread human-attention state for the supervisor inbox. */
export function ensureV55OutsiderAttentionSchema(sqlite: Database.Database): void {
  for (const table of ['github_issues', 'github_pull_requests'] as const) {
    for (const column of ATTENTION_COLUMNS) {
      ensureNullableTextColumn(sqlite, table, column);
    }
  }
}
