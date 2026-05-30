import path from 'node:path';
import { NextResponse } from 'next/server';
import { readAttemptLearnings, type AttemptLearning } from '@/lib/orchestrator/attempt-log';
import { getWorktreeManager } from '@/lib/worktree/launch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LatestLearning {
  worktreePath: string;
  learning: AttemptLearning;
  timestampMs: number;
}

function repoRootForWorkspace(workspacePath: string) {
  const resolved = path.resolve(workspacePath);
  for (const marker of ['/.cortex-worktrees/', '/.claude/worktrees/']) {
    const markerIndex = resolved.indexOf(marker);
    if (markerIndex > 0) {
      return resolved.slice(0, markerIndex);
    }
  }
  return resolved;
}

function uniquePaths(paths: string[]) {
  const seen = new Set<string>();
  return paths.reduce<string[]>((items, item) => {
    const normalized = path.resolve(item);
    if (seen.has(normalized)) {
      return items;
    }
    seen.add(normalized);
    items.push(normalized);
    return items;
  }, []);
}

function timestampMs(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestLearningForWorktree(worktreePath: string, learnings: AttemptLearning[]): LatestLearning | null {
  return learnings.reduce<LatestLearning | null>((latest, learning) => {
    const nextTimestamp = timestampMs(learning.timestamp);
    if (!latest || nextTimestamp > latest.timestampMs) {
      return { worktreePath, learning, timestampMs: nextTimestamp };
    }
    return latest;
  }, null);
}

function normalizeLearningFilePaths(filePaths: string[], worktreePath: string) {
  const root = path.resolve(worktreePath);
  const seen = new Set<string>();
  return filePaths.reduce<string[]>((items, filePath) => {
    const trimmed = filePath.trim();
    if (!trimmed) {
      return items;
    }
    const relative = path.isAbsolute(trimmed) ? path.relative(root, path.resolve(trimmed)) : trimmed;
    const normalized = relative && relative !== '.' && !relative.startsWith('..') ? relative : trimmed;
    if (seen.has(normalized)) {
      return items;
    }
    seen.add(normalized);
    items.push(normalized);
    return items;
  }, []);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspacePath = searchParams.get('workspace')?.trim();
    if (!workspacePath) {
      return NextResponse.json({ filePaths: [], worktreePath: null }, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    const repoRoot = repoRootForWorkspace(workspacePath);
    const worktrees = await getWorktreeManager(repoRoot).list().catch(() => []);
    const candidatePaths = uniquePaths([
      ...worktrees.map((worktree) => worktree.path),
      ...(path.resolve(workspacePath) !== repoRoot ? [workspacePath] : []),
    ]);

    const candidates = await Promise.all(candidatePaths.map(async (worktreePath) => {
      const learnings = await readAttemptLearnings(worktreePath).catch(() => []);
      return newestLearningForWorktree(worktreePath, learnings);
    }));
    const latest = candidates.reduce<LatestLearning | null>((current, candidate) => {
      if (!candidate) {
        return current;
      }
      if (!current || candidate.timestampMs > current.timestampMs) {
        return candidate;
      }
      return current;
    }, null);

    return NextResponse.json({
      filePaths: latest ? normalizeLearningFilePaths(latest.learning.filesChanged, latest.worktreePath) : [],
      worktreePath: latest?.worktreePath ?? null,
      timestamp: latest?.learning.timestamp ?? null,
      attempt: latest?.learning.attempt ?? null,
    }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load last-turn review scope' },
      { status: 500 },
    );
  }
}
