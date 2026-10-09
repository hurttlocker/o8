import type Database from 'better-sqlite3';

/** Display documents have no action capability and remain readable after a run ends. */
export function ensureV68TranscriptVisualizationsSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS transcript_visualizations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      html TEXT NOT NULL,
      height INTEGER NOT NULL,
      repo_path TEXT NOT NULL,
      thread_id TEXT,
      packet_id TEXT,
      created_at TEXT NOT NULL,
      CHECK ((thread_id IS NOT NULL) <> (packet_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_visualizations_thread
      ON transcript_visualizations(repo_path, thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_transcript_visualizations_packet
      ON transcript_visualizations(packet_id, created_at);
  `);
}
