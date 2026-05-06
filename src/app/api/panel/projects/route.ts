import { NextRequest, NextResponse } from 'next/server';
import {
  createProject,
  reconcileProjectsWithRegistry,
} from '@/lib/repos/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET() {
  try {
    const ledger = await reconcileProjectsWithRegistry();
    return NextResponse.json(ledger, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read projects.';
    return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim();
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400, headers: NO_STORE });
  }
  try {
    const ledger = await createProject(name);
    return NextResponse.json(ledger, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create project.';
    return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
  }
}
