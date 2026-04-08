export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getSqlite } from '@/lib/db';

interface ClusterData {
  label: string;
  type: string;
  factCount: number;
  avgConfidence: number;
  color: string;
}

interface OutcomeRow {
  repo_path: string;
  total: number;
  succeeded: number;
  failed: number;
  partial: number;
  interrupted: number;
  total_cost: number;
  total_tokens: number;
}

interface SearchRow {
  summary: string;
  outcome: string;
  repo_path: string;
  runtime: string;
  completed_at: string;
}

interface TotalsRow {
  total_sessions: number;
  total_succeeded: number;
  total_cost: number;
  total_tokens: number;
}

function ensureTable(db: ReturnType<typeof getSqlite>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_outcomes (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      branch TEXT,
      runtime TEXT NOT NULL,
      session_key TEXT,
      lane_id TEXT,
      packet_id TEXT,
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
    )
  `);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') || '';

  try {
    const db = getSqlite();
    ensureTable(db);

    // Clusters: group by repo_path
    const repoRows = db.prepare(`
      SELECT
        repo_path,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'succeeded' THEN 1 ELSE 0 END) as succeeded,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) as partial,
        SUM(CASE WHEN outcome = 'interrupted' THEN 1 ELSE 0 END) as interrupted,
        SUM(cost_usd) as total_cost,
        SUM(total_tokens) as total_tokens
      FROM session_outcomes
      GROUP BY repo_path
      ORDER BY total DESC
    `).all() as OutcomeRow[];

    const clusters: ClusterData[] = repoRows.map((row) => {
      const successRate = row.total > 0 ? row.succeeded / row.total : 0;
      const mostCommon = [
        { outcome: 'succeeded', count: row.succeeded },
        { outcome: 'failed', count: row.failed },
        { outcome: 'partial', count: row.partial },
        { outcome: 'interrupted', count: row.interrupted },
      ].sort((a, b) => b.count - a.count)[0];

      const type = mostCommon.outcome === 'succeeded' ? 'state' : 'decision';
      const color = successRate > 0.7 ? '#34c759' : successRate >= 0.4 ? '#ff9f0a' : '#ff3b30';
      const repoBasename = row.repo_path.split('/').pop() || row.repo_path;

      return {
        label: repoBasename,
        type,
        factCount: row.total,
        avgConfidence: Math.round(successRate * 100),
        color,
      };
    });

    // Stats: totals
    const totals = db.prepare(`
      SELECT
        COUNT(*) as total_sessions,
        SUM(CASE WHEN outcome = 'succeeded' THEN 1 ELSE 0 END) as total_succeeded,
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(total_tokens), 0) as total_tokens
      FROM session_outcomes
    `).get() as TotalsRow;

    const successRate = totals.total_sessions > 0
      ? ((totals.total_succeeded / totals.total_sessions) * 100).toFixed(1)
      : '0';

    const stats = {
      totalSessions: totals.total_sessions,
      successRate,
      totalCost: totals.total_cost,
      totalTokens: totals.total_tokens,
    };

    // Search: when ?q= provided
    let searchResults: { text: string; confidence: number; source: string; type: string }[] = [];
    if (query) {
      const matchingRows = db.prepare(`
        SELECT summary, outcome, repo_path, runtime, completed_at
        FROM session_outcomes
        WHERE summary LIKE ?
        ORDER BY completed_at DESC
        LIMIT 30
      `).all(`%${query}%`) as SearchRow[];

      searchResults = matchingRows.map((row) => ({
        text: row.summary.slice(0, 140),
        confidence: row.outcome === 'succeeded' ? 90 : row.outcome === 'partial' ? 60 : 30,
        source: row.repo_path.split('/').pop() || row.repo_path,
        type: row.outcome === 'succeeded' ? 'state' : 'decision',
      }));
    }

    return NextResponse.json({ clusters, searchResults, stats });
  } catch (err) {
    console.error('[cortex-graph] error:', err);
    return NextResponse.json({
      clusters: [],
      searchResults: [],
      stats: { totalSessions: 0, successRate: '0', totalCost: 0, totalTokens: 0 },
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
