import { NextRequest, NextResponse } from 'next/server';
import { setActiveProject } from '@/lib/repos/projects';
import { withRepoInventoryChange } from '@/lib/repos/inventory-change-publish';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

async function handlePOST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { projectId?: string } | null;
  const projectId = body?.projectId?.trim();
  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400, headers: NO_STORE });
  }
  try {
    const ledger = await setActiveProject(projectId);
    return NextResponse.json(ledger, { headers: NO_STORE });
  } catch (error) {
    console.error('[api] panel/projects/active failed:', error);
    const message = 'Failed to switch project.';
    return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
  }
}

export const POST = withRepoInventoryChange('project-switch', handlePOST);
