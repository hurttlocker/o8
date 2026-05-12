import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getMergeWarmupSnapshot, prewarmMergePath } from '@/lib/orchestrator/operator-mission-service/merge-warmup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JSON_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const snapshot = getMergeWarmupSnapshot();
  if (!snapshot.ready) {
    void prewarmMergePath().catch((error) => {
      console.warn('[orchestrator-health] merge warmup failed:', error);
    });
  }

  return NextResponse.json({
    merge: snapshot.ready ? 'ready' : 'warming',
    durationMs: Date.now() - startedAt,
  }, {
    headers: JSON_HEADERS,
  });
}
