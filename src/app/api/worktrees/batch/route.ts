export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { WorktreeInfo } from '@/lib/worktree/types';

interface BatchListBody {
  repoPaths: string[];
}

const WORKTREE_LIST_CONCURRENCY = 4;
const MAX_BATCH_REPO_PATHS = 64;

async function mapSettledWithConcurrency<T, TResult>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<TResult>,
): Promise<Array<PromiseSettledResult<TResult>>> {
  if (items.length === 0) return [];

  const results = new Array<PromiseSettledResult<TResult>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      try {
        results[currentIndex] = {
          status: 'fulfilled',
          value: await mapper(items[currentIndex]!),
        };
      } catch (reason) {
        results[currentIndex] = { status: 'rejected', reason };
      }
    }
  }));
  return results;
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

  if (repoPaths.length > MAX_BATCH_REPO_PATHS) {
    return NextResponse.json(
      {
        error: `A worktree batch may include at most ${MAX_BATCH_REPO_PATHS} repositories.`,
        maxRepoPaths: MAX_BATCH_REPO_PATHS,
      },
      { status: 413 },
    );
  }

  const settled = await mapSettledWithConcurrency(
    repoPaths,
    WORKTREE_LIST_CONCURRENCY,
    async (repoPath) => ({
      repoPath,
      worktrees: await getWorktreeManager(repoPath).list(),
    }),
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
