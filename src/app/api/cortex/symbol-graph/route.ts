/**
 * POST /api/cortex/symbol-graph
 *
 * Body: { repoPath: string; symbols?: string[]; text?: string }
 *
 * Either pass pre-extracted `symbols` or a free-form `text` (issue body /
 * packet summary) and we'll pull symbols out via `extractSymbols`. The
 * route returns the trace_path edges that the Context Recall Card (#742)
 * renders in its SYMBOL GRAPH row.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     symbols: string[],
 *     edges: SymbolEdge[],
 *     unavailable?: boolean   // true when codebase-memory-mcp isn't installed
 *   }
 *
 * Failure modes — every failure returns `ok: true` with `unavailable: true`
 * or `edges: []`. The card hides the row gracefully on either signal; we
 * never want a 500 here to surface as an error banner in the orchestrator.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { extractSymbols, traceSymbols, type SymbolEdge } from '@/lib/codebase-memory/client';

interface PostBody {
  repoPath?: string;
  symbols?: string[];
  text?: string;
  limit?: number;
}

export async function POST(request: NextRequest) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }

  const repoPath = typeof body.repoPath === 'string' ? body.repoPath.trim() : '';
  if (!repoPath) {
    return NextResponse.json({ ok: false, error: 'repoPath is required.' }, { status: 400 });
  }

  const limit = typeof body.limit === 'number' ? Math.max(1, Math.min(5, body.limit)) : 3;

  let symbols: string[];
  if (Array.isArray(body.symbols) && body.symbols.length > 0) {
    symbols = body.symbols.slice(0, limit);
  } else if (typeof body.text === 'string') {
    symbols = extractSymbols(body.text, limit);
  } else {
    symbols = [];
  }

  if (symbols.length === 0) {
    const empty: { ok: true; symbols: string[]; edges: SymbolEdge[] } = { ok: true, symbols: [], edges: [] };
    return NextResponse.json(empty, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  try {
    const traced = await traceSymbols({ repoPath, symbols });
    return NextResponse.json(
      {
        ok: true,
        symbols,
        edges: traced.edges,
        unavailable: traced.unavailable || undefined,
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    console.warn('[symbol-graph] trace failed:', error);
    return NextResponse.json(
      { ok: true, symbols, edges: [], unavailable: true },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
