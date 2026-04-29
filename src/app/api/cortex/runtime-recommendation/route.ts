/**
 * GET /api/cortex/runtime-recommendation?repoPath=<absolute-path>
 *
 * Returns the dispatch routing recommendation for a single repo. Backed by
 * `recommendRuntime()` (#747) which scores runtimes by `merged_clean` win
 * rate over the live (non-decayed) outcomes for the repo.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     recommendation: {
 *       runtime: 'codex' | 'claude-code' | 'gemini' | 'opencode' | null,
 *       score: number,         // 0..1, only meaningful when runtime != null
 *       evidence: {            // per-runtime breakdown for tooltip / audit
 *         [runtime]: { runtime, score, total, mergedClean }
 *       }
 *     }
 *   }
 *
 * `runtime: null` means insufficient sample to recommend — the caller should
 * fall through to the user's default (codex). The `evidence` map is still
 * populated so the UI can show coverage.
 *
 * Local-only by design: `/api/cortex/*` is gated by the global middleware on
 * loopback origin + ws-token. No additional auth needed here.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { recommendRuntime } from '@/lib/dispatch/routing';
import { withTiming } from '@/lib/cortex/diagnostics';

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const repoPath = params.get('repoPath')?.trim() ?? '';
  if (!repoPath) {
    return NextResponse.json(
      { ok: false, error: 'repoPath is required.' },
      { status: 400 },
    );
  }

  try {
    const recommendation = await withTiming(
      'recall.runtime-recommendation',
      () => recommendRuntime(repoPath),
    );
    return NextResponse.json(
      { ok: true, recommendation },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : 'Unable to compute runtime recommendation.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
