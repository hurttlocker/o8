/**
 * POST /api/cortex/ask  (epic #915 sub-2 — real composer)
 *
 * Accepts: { question: string, repoPath?: string, mode?: 'brain' | 'memory' }
 *
 * Runs the full Q&A pipeline:
 *   1. Flash classifier (50ms) → question class + BM25 variants
 *   2. retrieveAll (sql + fts5 + graph) → union-merged TypedRows
 *   3. Compose:
 *        Class A → Gemini Flash JSON (200–500ms, one-sentence)
 *        Class B → Claude Sonnet streaming (1–3s TTFT)
 *   4. Stream SSE frames:
 *        event: open       { ok: true }
 *        event: token      { text: string }
 *        event: citation   { kind, rowId, table, excerpt?, url? }
 *        event: alert      { kind, message, fromHouse, toHouse, fromModel, toModel }
 *        event: done       {}
 *        event: error      { message: string }
 *
 * Cache: 30min in-process TTL (normalized key, eagerly invalidated on
 * spec-ingest + ledger writes — see ask.ts).
 * Bypass: ?force=1 query param OR body { bypassCache: true } — aligned with
 * the JSON sibling /api/cortex/ask/answer so callers don't have to know
 * which route takes which shape (cost a live debugging session 2026-06-11).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';

import { runAskPipeline } from '@/lib/cortex/qa/ask';

interface AskBody {
  question?: unknown;
  repoPath?: unknown;
  projectId?: unknown;
  mode?: unknown;
  terse?: unknown;
  bypassCache?: unknown;
}

function sseEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as AskBody | null;
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) {
    return new Response(JSON.stringify({ ok: false, error: 'question is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const repoPath =
    typeof body?.repoPath === 'string' && body.repoPath.trim() ? body.repoPath.trim() : undefined;
  const projectId =
    typeof body?.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : undefined;

  const force = request.nextUrl.searchParams.get('force') === '1' || body?.bypassCache === true;
  const terse = body?.terse === true;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Stream may already be closed if the client disconnected.
        }
      };

      const emit = (name: string, payload: unknown) => {
        enqueue(sseEvent(name, payload));
      };

      try {
        emit('open', { ok: true });
        await runAskPipeline(question, repoPath, emit, force, projectId, { terse });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'pipeline error';
        console.error('[qa][ask-route] pipeline error:', message);
        emit('error', { message });
        emit('done', {});
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
