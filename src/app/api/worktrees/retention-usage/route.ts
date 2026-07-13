/**
 * GET /api/worktrees/retention-usage
 *
 * Cheap du-style snapshot of `.cortex-worktrees` disk footprint across every
 * registered repo — powers the "current count + measured size" status row in
 * the Worktrees retention settings section. Read-only; gated by the default-deny
 * middleware like every other /api/worktrees route.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { NextResponse, type NextRequest } from 'next/server';

import { requirePanelAuth } from '@/lib/panel/auth';
import { listRepos } from '@/lib/repos/registry';

const execFileAsync = promisify(execFile);
const WORKTREE_DIR_NAME = '.cortex-worktrees';

interface RepoUsage {
  name: string;
  path: string;
  count: number;
  bytes: number;
}

/** Count immediate packet-worktree subdirectories (skips .meta.json + dotfiles). */
async function countWorktrees(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).length;
  } catch {
    return 0; // dir doesn't exist yet → zero worktrees
  }
}

/** `du -sk` the worktree dir → bytes. Returns 0 when the dir is absent. */
async function measureBytes(dir: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('du', ['-sk', dir], { timeout: 8000 });
    const kb = parseInt(stdout.split('\t')[0] ?? '0', 10);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const repos = await listRepos();
    const perRepo = await Promise.all(
      repos.map(async (repo): Promise<RepoUsage | null> => {
        const localPath = repo.localPath;
        if (!localPath) return null;
        const worktreeDir = path.join(localPath, WORKTREE_DIR_NAME);
        const [count, bytes] = await Promise.all([
          countWorktrees(worktreeDir),
          measureBytes(worktreeDir),
        ]);
        if (count === 0 && bytes === 0) return null; // nothing on disk — omit
        return { name: repo.name ?? path.basename(localPath), path: worktreeDir, count, bytes };
      }),
    );

    const rows = perRepo.filter((r): r is RepoUsage => r !== null);
    const totalCount = rows.reduce((sum, r) => sum + r.count, 0);
    const totalBytes = rows.reduce((sum, r) => sum + r.bytes, 0);

    return NextResponse.json({
      totalCount,
      totalBytes,
      totalGb: totalBytes / 1024 / 1024 / 1024,
      repos: rows,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to measure worktree usage.' },
      { status: 500 },
    );
  }
}
