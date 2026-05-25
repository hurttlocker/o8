export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/orchestrator/threads — list recent orchestrator threads for
 * the mobile Orchestrator tab.
 * POST /api/mobile/orchestrator/threads — create a desktop-owned built-in
 * o8/Claude thread so mobile and desktop share the same `thoughts-*` id.
 *
 * Reads ~/.o8/chat-history/thoughts-*.json directly (same pattern as the
 * desktop OrchestratorHistorySidebar, which calls /api/v2/chat-history/list
 * with ?include=orchestrator). Projects each thread into a tiny mobile-shaped
 * payload with title, last activity, runtime, status, repo context, and count.
 *
 * Returns: { threads: MobileOrchestratorThread[] } — at most 20 most-recent.
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  createMobileOrchestratorThread,
  listMobileOrchestratorThreads,
} from '@/lib/mobile/orchestrator-thread-history';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET(request: NextRequest) {
  // ?backend=openclaw → only openclaw threads; otherwise → non-openclaw
  // threads (the default Orchestrator surface; untagged/legacy threads count
  // as non-openclaw). The two surfaces coexist — see docs/openclaw-integration.md.
  const wantOpenclaw = request.nextUrl.searchParams.get('backend') === 'openclaw';

  try {
    const threads = listMobileOrchestratorThreads({ backend: wantOpenclaw ? 'openclaw' : null });
    return NextResponse.json({ threads }, { headers: NO_STORE });
  } catch (error) {
    console.log('[mobile-orchestrator] thread list failed', error);
    return NextResponse.json({ threads: [] }, { headers: NO_STORE });
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | {
        repoPath?: string;
        title?: string | null;
        repoName?: string | null;
        repoBranch?: string | null;
        reveal?: boolean;
      }
    | null;

  if (!body || typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
    return NextResponse.json({ error: 'repoPath is required' }, { status: 400, headers: NO_STORE });
  }

  try {
    const thread = createMobileOrchestratorThread({
      repoPath: body.repoPath,
      title: body.title,
      repoName: body.repoName,
      repoBranch: body.repoBranch,
      reveal: body.reveal,
    });
    return NextResponse.json({ thread }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create orchestrator thread.';
    return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
  }
}
