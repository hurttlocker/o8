import { NextResponse } from 'next/server';
import { getWorkspaceReviewSnapshot } from '@/lib/review/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspacePath = searchParams.get('workspace');
    const repoSlug = searchParams.get('repo');
    const strictBranch = searchParams.get('strictBranch') === '1';
    const snapshot = await getWorkspaceReviewSnapshot({
      workspacePath,
      repoSlug,
      allowFallbackPullRequests: !strictBranch,
    });
    return NextResponse.json(snapshot, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to load workflow review snapshot',
      },
      { status: 500 },
    );
  }
}
