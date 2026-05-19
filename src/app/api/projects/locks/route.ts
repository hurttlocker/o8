import { NextResponse, type NextRequest } from 'next/server';

import { requirePanelAuth } from '@/lib/panel/auth';
import { listProjectLocks } from '@/lib/projects/locks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const projectId = new URL(req.url).searchParams.get('projectId');
    const locks = await listProjectLocks(projectId);
    return NextResponse.json({
      schema: 'o8/project-locks/v1',
      locks,
    }, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list project locks.';
    return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE });
  }
}
