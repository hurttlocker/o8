import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { resolveRepoPathFromRegistry } from '@/lib/repos/repo-path-registry';
import { autoCompactOrchestratorThread } from '@/lib/orchestrator/auto-compact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as {
    repoPath?: unknown;
    runningTotal?: unknown;
    messages?: unknown;
  } | null;
  const repoPath = typeof body?.repoPath === 'string' ? body.repoPath.trim() : '';
  if (!repoPath) {
    return NextResponse.json({ ok: false, error: 'repoPath is required' }, { status: 400 });
  }

  const resolved = await resolveRepoPathFromRegistry(repoPath);
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.message }, { status: resolved.status });
  }

  try {
    const result = await autoCompactOrchestratorThread({
      repoPath: resolved.repoRoot,
      runningTotal: typeof body?.runningTotal === 'number' ? body.runningTotal : undefined,
      liveMessages: Array.isArray(body?.messages) ? body.messages as MobileTranscriptEntry[] : undefined,
    });
    return NextResponse.json({ ok: true, ...result }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Compaction failed',
    }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }
}
