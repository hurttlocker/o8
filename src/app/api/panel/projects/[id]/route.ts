import { NextRequest, NextResponse } from 'next/server';
import { deleteProject, renameProject, setProjectRepos } from '@/lib/repos/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as
    | { name?: string; repoPaths?: string[] }
    | null;
  if (!body) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400, headers: NO_STORE });
  }
  try {
    let ledger;
    if (typeof body.name === 'string') {
      ledger = await renameProject(id, body.name);
    }
    if (Array.isArray(body.repoPaths)) {
      ledger = await setProjectRepos(id, body.repoPaths);
    }
    if (!ledger) {
      return NextResponse.json({ error: 'nothing to update' }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json(ledger, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update project.';
    return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  try {
    const ledger = await deleteProject(id);
    return NextResponse.json(ledger, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete project.';
    return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
  }
}
