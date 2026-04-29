import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  deleteProject,
  getProjectWithRepos,
  updateProject,
} from '@/lib/projects/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { id } = await params;
  const project = getProjectWithRepos(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }
  return NextResponse.json({ project }, { headers: NO_STORE });
}

interface UpdateProjectBody {
  name?: unknown;
  description?: unknown;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { id } = await params;
  let body: UpdateProjectBody;
  try {
    body = (await req.json()) as UpdateProjectBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const updates: { name?: string; description?: string | null } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      return NextResponse.json({ error: 'name must be a string.' }, { status: 400 });
    }
    updates.name = body.name;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      return NextResponse.json({ error: 'description must be a string or null.' }, { status: 400 });
    }
    updates.description = body.description as string | null;
  }

  try {
    const project = updateProject(id, updates);
    if (!project) {
      return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
    }
    const withRepos = getProjectWithRepos(id);
    return NextResponse.json({ project: withRepos ?? project }, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update project.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const { id } = await params;
  const deleted = deleteProject(id);
  if (!deleted) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
