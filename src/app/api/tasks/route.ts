import { NextResponse, type NextRequest } from 'next/server';

import { requirePanelAuth } from '@/lib/panel/auth';
import { getTaskPool } from '@/lib/tasks/pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const projectId = params.get('projectId')?.trim() || null;
  const repoPath = params.get('repoPath')?.trim() || null;
  const includeDone = params.get('includeDone') === 'true';
  const includeBrief = params.get('includeBrief') === 'true';

  try {
    const pool = await getTaskPool({ projectId, repoPath, includeDone, includeBrief });
    return NextResponse.json(pool, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to read task pool.' },
      { status: 500 },
    );
  }
}
