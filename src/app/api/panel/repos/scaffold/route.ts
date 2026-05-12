import { NextResponse, type NextRequest } from 'next/server';
import { scaffoldRepo } from '@/lib/repos/bootstrap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

interface ScaffoldRepoBody {
  path?: unknown;
  repoPath?: unknown;
  kind?: unknown;
  name?: unknown;
}

function bodyPath(body: ScaffoldRepoBody): string {
  const value = typeof body.repoPath === 'string'
    ? body.repoPath
    : typeof body.path === 'string'
      ? body.path
      : '';
  return value.trim();
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as ScaffoldRepoBody | null;
  const repoPath = body ? bodyPath(body) : '';
  const kind = typeof body?.kind === 'string' ? body.kind.trim() : '';
  if (!repoPath) {
    return NextResponse.json({ error: 'repoPath is required' }, { status: 400, headers: NO_STORE });
  }
  if (!kind) {
    return NextResponse.json({ error: 'kind is required' }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await scaffoldRepo(
      repoPath,
      kind,
      typeof body?.name === 'string' ? body.name : undefined,
    );
    return NextResponse.json({
      scaffolded: result.scaffolded,
      kind: result.kind,
      filesWritten: result.filesWritten,
      skippedFiles: result.skippedFiles,
      committed: result.committed,
      repo: result.repo,
      repoPath: result.repo.localPath,
      projectId: result.projectId,
    }, { status: 201, headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to scaffold repository.';
    return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE });
  }
}
