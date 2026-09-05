import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const cacheRoot = join(process.cwd(), 'node_modules', '.cache');
mkdirSync(cacheRoot, { recursive: true });
const dataDir = mkdtempSync(join(cacheRoot, 'o8-existing-schema-boot-'));
const dbPath = join(dataDir, 'cortex-ide.db');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('existing database boot migration', () => {
  it('adds legacy columns before creating indexes that depend on them', async () => {
    const initialDb = await import('@/lib/db');
    initialDb.getSqlite();
    initialDb.closeDb();
    // The top marker gates the boot migration; read the version rather than
    // pinning it so a schema bump cannot silently turn this into a no-op run.
    const topMarkerPath = join(dataDir, `.db-migrated-v${initialDb.DB_SCHEMA_VERSION}`);

    const fixture = new Database(dbPath);
    fixture.exec(`
      DROP TABLE session_outcomes;
      CREATE TABLE session_outcomes (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        repo_path TEXT NOT NULL,
        branch TEXT,
        runtime TEXT NOT NULL,
        session_key TEXT,
        outcome TEXT NOT NULL,
        summary TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        retry_history_json TEXT NOT NULL DEFAULT '[]',
        duration_ms INTEGER,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        model TEXT,
        patterns_json TEXT NOT NULL DEFAULT '[]',
        conflict_zones_json TEXT NOT NULL DEFAULT '[]',
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        review_approved INTEGER,
        review_findings_count INTEGER NOT NULL DEFAULT 0,
        transcript_path TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    fixture.close();
    unlinkSync(topMarkerPath);

    vi.resetModules();
    const upgradedDb = await import('@/lib/db');
    const sqlite = upgradedDb.getSqlite();
    const columns = sqlite.prepare('PRAGMA table_info(session_outcomes)').all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name);

    expect(columnNames).toEqual(expect.arrayContaining([
      'lane_id',
      'packet_id',
      'valid_from',
      'valid_to',
    ]));
    expect(sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN ('idx_so_lane_id', 'idx_so_packet_id', 'idx_so_valid_to')
      ORDER BY name
    `).all()).toEqual([
      { name: 'idx_so_lane_id' },
      { name: 'idx_so_packet_id' },
      { name: 'idx_so_valid_to' },
    ]);
    expect(existsSync(topMarkerPath)).toBe(true);

    upgradedDb.closeDb();
  });
});
