/**
 * GET /api/panel/qa-evals
 *
 * Returns qa_eval_runs rows for the regression dashboard (#969).
 * Reads from the `qa_eval_runs` table (schema v14).
 *
 * Query params:
 *   limit  — max rows (default 500, max 2000)
 *   format — "json" (default) | "csv"
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { getSqlite } from '@/lib/db';

interface EvalRow {
  id: string;
  question_id: string;
  category: string | null;
  expected_answer: string;
  actual_answer: string;
  factual_accuracy: number | null;
  citation_correctness: number | null;
  hallucination_count: number | null;
  run_at: number;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limitParam = parseInt(url.searchParams.get('limit') ?? '500', 10);
    const limit = Math.min(isNaN(limitParam) ? 500 : limitParam, 2000);
    const format = url.searchParams.get('format') ?? 'json';

    const db = getSqlite();

    // Check that the table exists (schema v14 may not have run yet on some installs).
    const tableExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='qa_eval_runs'`)
      .get();
    if (!tableExists) {
      return NextResponse.json({ runs: [], error: 'qa_eval_runs table not yet migrated (schema v14 required)' });
    }

    const rows = db
      .prepare(
        `SELECT id, question_id, category, expected_answer, actual_answer,
                factual_accuracy, citation_correctness, hallucination_count, run_at
         FROM qa_eval_runs
         ORDER BY run_at DESC
         LIMIT ?`,
      )
      .all(limit) as EvalRow[];

    if (format === 'csv') {
      const header = 'id,question_id,category,factual_accuracy,citation_correctness,hallucination_count,run_at\r\n';
      const lines = rows.map((r) => [
        csvEscape(r.id),
        csvEscape(r.question_id),
        csvEscape(r.category ?? ''),
        r.factual_accuracy !== null ? r.factual_accuracy.toFixed(4) : '',
        r.citation_correctness !== null ? r.citation_correctness.toFixed(4) : '',
        r.hallucination_count !== null ? String(r.hallucination_count) : '',
        String(r.run_at),
      ].join(','));
      const csv = header + lines.join('\r\n');
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="qa-eval-runs.csv"',
        },
      });
    }

    return NextResponse.json({ runs: rows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[qa-evals] GET failed:', msg);
    return NextResponse.json({ runs: [], error: msg }, { status: 500 });
  }
}

function csvEscape(val: string): string {
  if (/[",\r\n]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
  return val;
}
