/**
 * Targeting Machine — score cache.
 *
 * Caches computed target scores in ~/.o8/skeleton.db (same disposable cache DB
 * as the skeleton map; deletable anytime with zero data loss). Own singleton +
 * pragma set, mirroring skeleton/store.ts. v1 is on-demand: the API recomputes +
 * replaces a repo's scores per request (cheap — signals are pre-computed), and
 * this is the read surface + the seed for step-8 observability.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import type { TargetSignals } from './signals';
import type { TargetScore } from './scorer';
import { getDataDir } from '@/lib/data-dir-migration';

const DATA_DIR = getDataDir();
const DB_PATH = path.join(DATA_DIR, 'skeleton.db');

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 3000');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS targeting_scores (
      repo_path    TEXT NOT NULL,
      file_path    TEXT NOT NULL,
      impact       INTEGER NOT NULL,
      opportunity  INTEGER NOT NULL,
      score        INTEGER NOT NULL,
      rationale    TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      scored_at    TEXT NOT NULL,
      PRIMARY KEY (repo_path, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_targeting_repo ON targeting_scores(repo_path);
  `);

  return _db;
}

/** Replace all cached scores for a repo in one transaction. */
export function replaceScores(repoPath: string, scores: TargetScore[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const del = db.prepare('DELETE FROM targeting_scores WHERE repo_path = ?');
  const ins = db.prepare(`
    INSERT INTO targeting_scores (repo_path, file_path, impact, opportunity, score, rationale, signals_json, scored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    del.run(repoPath);
    for (const s of scores) {
      ins.run(repoPath, s.path, s.impact, s.opportunity, s.score, s.rationale, JSON.stringify(s.signals), now);
    }
  })();
}

interface ScoreRow {
  file_path: string;
  impact: number;
  opportunity: number;
  score: number;
  rationale: string;
  signals_json: string;
}

/** Read cached scores for a repo, highest score first. */
export function getScores(repoPath: string): TargetScore[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM targeting_scores WHERE repo_path = ? ORDER BY score DESC, file_path ASC',
  ).all(repoPath) as ScoreRow[];

  return rows.map((row) => ({
    path: row.file_path,
    impact: row.impact,
    opportunity: row.opportunity,
    score: row.score,
    rationale: row.rationale,
    signals: JSON.parse(row.signals_json) as TargetSignals,
  }));
}
