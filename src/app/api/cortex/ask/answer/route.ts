/**
 * POST /api/cortex/ask/answer  (epic #915 — MCP-callable Q&A endpoint)
 *
 * Non-streaming JSON sibling of the SSE route at /api/cortex/ask. Used by the
 * cortex_ask MCP tool — external Claude / Codex sessions can hit this to query
 * the Engineering Brain and get a single JSON answer back (no SSE parsing).
 *
 * Accepts: { question: string, repoPath?: string, projectId?: string, bypassCache?: boolean }
 * Returns: { ok: true, answer, citations, class, retrievalMs, classifyMs } | { ok: false, error }
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';

import { askCortex } from '@/lib/cortex/qa/ask';

interface AskAnswerBody {
  question?: unknown;
  repoPath?: unknown;
  projectId?: unknown;
  bypassCache?: unknown;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as AskAnswerBody | null;
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) {
    return NextResponse.json(
      { ok: false, error: 'question is required' },
      { status: 400 },
    );
  }

  const repoPath =
    typeof body?.repoPath === 'string' && body.repoPath.trim() ? body.repoPath.trim() : undefined;
  const projectId =
    typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null;
  const bypassCache = body?.bypassCache === true;

  try {
    const result = await askCortex(question, repoPath, { bypassCache, projectId });
    return NextResponse.json({
      ok: true,
      answer: result.answer,
      citations: result.citations,
      class: result.class,
      retrievalMs: result.retrievalMs,
      classifyMs: result.classifyMs,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
