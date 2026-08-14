import { NextRequest, NextResponse } from 'next/server';

import { buildErrorPayload } from '@/lib/api/error-format';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getRuntimeEvidenceSnapshot } from '@/lib/runtime/runtime-evidence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = requirePanelAuth(request);
  if (auth) return auth;

  try {
    const snapshot = await getRuntimeEvidenceSnapshot({
      fresh: request.nextUrl.searchParams.get('fresh') === '1',
      repoPath: request.nextUrl.searchParams.get('repoPath')?.trim() || process.cwd(),
    });
    return NextResponse.json(snapshot, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json(
      buildErrorPayload('Failed to load runtime evidence.', error),
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
