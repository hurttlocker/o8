import { NextResponse } from 'next/server';
import type { WorkflowReviewSnapshot } from '@/lib/fleet/types';
import { getWorkspaceReviewSnapshot } from '@/lib/review/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMPTY_SNAPSHOT: WorkflowReviewSnapshot = {
  generatedAt: new Date(0).toISOString(),
  repoSlug: '',
  repoPath: '',
  branch: '',
  ahead: 0,
  behind: 0,
  dirty: false,
  changedFiles: [],
  diffStat: '',
  recentCommits: [],
  worktrees: [],
  pullRequests: [],
  activeIssues: [],
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspacePath = searchParams.get('workspace');
    const repoSlug = searchParams.get('repo');
    const strictBranch = searchParams.get('strictBranch') === '1';

    // Do not let a missing workspace param silently fall through to
    // process.cwd(). The client is expected to pass an absolute workspace
    // path; when the user has no repo selected the panel should render an
    // empty state, not whichever repo the Node server is sitting in.
    if (!workspacePath && !process.env.CORTEX_IDE_REVIEW_REPO_ROOT) {
      return NextResponse.json(
        { ...EMPTY_SNAPSHOT, generatedAt: new Date().toISOString() },
        { headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }

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
