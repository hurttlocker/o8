import { NextRequest, NextResponse } from 'next/server';
import { setActiveProject } from '@/lib/repos/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { projectId?: string } | null;
  const projectId = body?.projectId?.trim();
  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400, headers: NO_STORE });
  }
  try {
    const ledger = await setActiveProject(projectId);
    return NextResponse.json(ledger, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to switch project.';
    return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
  }
}
