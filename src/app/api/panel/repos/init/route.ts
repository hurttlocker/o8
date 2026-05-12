import { NextResponse, type NextRequest } from 'next/server';
import { initRepo } from '@/lib/repos/bootstrap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

interface InitRepoBody {
  path?: unknown;
  repoPath?: unknown;
  name?: unknown;
}

function bodyPath(body: InitRepoBody): string {
  const value = typeof body.path === 'string'
    ? body.path
    : typeof body.repoPath === 'string'
      ? body.repoPath
      : '';
  return value.trim();
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as InitRepoBody | null;
  const repoPath = body ? bodyPath(body) : '';
  if (!repoPath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await initRepo(
      repoPath,
      typeof body?.name === 'string' ? body.name : undefined,
    );
    return NextResponse.json({
      initialized: result.initialized,
      initialCommit: result.initialCommit,
      repo: result.repo,
      repoPath: result.repo.localPath,
      projectId: result.projectId,
    }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to initialize repository.';
    return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE });
  }
}
