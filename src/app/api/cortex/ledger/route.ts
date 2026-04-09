export const dynamic = 'force-dynamic';

/**
 * Cortex Session Ledger — lists recent session outcomes across all repos.
 * Used by the Ledger tab in the Memory view for dogfooding observability.
 */

import { NextResponse } from 'next/server';
import { getSqlite } from '@/lib/db';

interface LedgerRow {
  id: string;
  repo_path: string;
  branch: string | null;
  runtime: string;
  outcome: string;
  summary: string;
  attempts: number;
  duration_ms: number | null;
  total_tokens: number;
  cost_usd: number;
  model: string | null;
  review_approved: number | null;
  review_findings_count: number;
  started_at: string;
  completed_at: string;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const repoPath = url.searchParams.get('repoPath');

    const db = getSqlite();

    // Ensure table exists (defensive, matches ledger.ts schema)
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

    let rows: LedgerRow[];
    if (repoPath) {
      rows = db.prepare(`
        SELECT id, repo_path, branch, runtime, outcome, summary, attempts,
               duration_ms, total_tokens, cost_usd, model,
               review_approved, review_findings_count, started_at, completed_at
        FROM session_outcomes
        WHERE repo_path = ?
        ORDER BY completed_at DESC
        LIMIT ?
      `).all(repoPath, limit) as LedgerRow[];
    } else {
      rows = db.prepare(`
        SELECT id, repo_path, branch, runtime, outcome, summary, attempts,
               duration_ms, total_tokens, cost_usd, model,
               review_approved, review_findings_count, started_at, completed_at
        FROM session_outcomes
        ORDER BY completed_at DESC
        LIMIT ?
      `).all(limit) as LedgerRow[];
    }

    // Aggregate stats
    const totalRow = db.prepare(`SELECT COUNT(*) as total, SUM(cost_usd) as cost FROM session_outcomes`).get() as { total: number; cost: number };

    const outcomes = rows.map((row) => ({
      id: row.id,
      repoPath: row.repo_path,
      repoName: row.repo_path.split('/').pop() || row.repo_path,
      branch: row.branch,
      runtime: row.runtime,
      outcome: row.outcome,
      summary: row.summary,
      attempts: row.attempts,
      durationMs: row.duration_ms,
      totalTokens: row.total_tokens,
      costUsd: row.cost_usd,
      model: row.model,
      reviewApproved: row.review_approved,
      reviewFindingsCount: row.review_findings_count,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }));

    return NextResponse.json({
      outcomes,
      totals: {
        count: totalRow?.total ?? 0,
        costUsd: totalRow?.cost ?? 0,
      },
    });
  } catch (error) {
    console.error('[cortex/ledger] error:', error);
    return NextResponse.json({ error: 'Failed to query ledger', outcomes: [], totals: { count: 0, costUsd: 0 } }, { status: 500 });
  }
}
