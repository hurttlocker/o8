import type Database from 'better-sqlite3';

export function ensureV69VisualizationVersionsSchema(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS transcript_visualization_versions (
    id TEXT PRIMARY KEY REFERENCES transcript_visualizations(id) ON DELETE CASCADE,
    root_id TEXT NOT NULL REFERENCES transcript_visualizations(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES transcript_visualizations(id),
    version INTEGER NOT NULL CHECK(version >= 1),
    source TEXT NOT NULL,
    UNIQUE(root_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_visualization_versions_root ON transcript_visualization_versions(root_id, version);`);
}
