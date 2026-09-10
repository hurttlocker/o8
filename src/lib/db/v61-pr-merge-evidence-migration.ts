import type Database from 'better-sqlite3';

/** Preserve the immutable commits reported by a merged pull request. */
export function ensureV61PrMergeEvidenceSchema(sqlite: Database.Database): void {
  for (const column of ['head_sha', 'merge_commit']) {
    const columns = sqlite.prepare('PRAGMA table_info(github_pull_requests)').all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) continue;
    try {
      sqlite.exec(`ALTER TABLE github_pull_requests ADD COLUMN ${column} TEXT`);
    } catch (error) {
      if (!(error instanceof Error && /duplicate column name/i.test(error.message))) throw error;
    }
  }
}
