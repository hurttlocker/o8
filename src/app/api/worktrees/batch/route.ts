export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { WorktreeInfo } from '@/lib/worktree/types';

interface BatchListBody {
  repoPaths: string[];
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  let body: BatchListBody;
  try {
    body = (await req.json()) as BatchListBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(body.repoPaths) || body.repoPaths.some((repoPath) => typeof repoPath !== 'string')) {
    return NextResponse.json({ error: 'repoPaths must be an array of strings' }, { status: 400 });
  }

  const repoPaths = Array.from(new Set(
    body.repoPaths
      .map((repoPath) => repoPath.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  ));

  const settled = await Promise.allSettled(
    repoPaths.map(async (repoPath) => ({
      repoPath,
      worktrees: await getWorktreeManager(repoPath).list(),
    })),
  );

  const worktreesByRepo: Record<string, WorktreeInfo[]> = {};

  settled.forEach((result, index) => {
    const repoPath = repoPaths[index];
    if (!repoPath) return;

    if (result.status === 'fulfilled') {
      worktreesByRepo[repoPath] = result.value.worktrees;
      return;
    }

    console.error(`Failed to list worktrees for repo: ${repoPath}`, result.reason);
    worktreesByRepo[repoPath] = [];
  });

  return NextResponse.json(worktreesByRepo);
}
