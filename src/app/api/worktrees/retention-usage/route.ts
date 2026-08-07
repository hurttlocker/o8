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
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';

const execFileAsync = promisify(execFile);

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
    const { stdout } = await execFileAsync('du', ['-sk', dir], { windowsHide: true, timeout: 8000 });
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
        const layout = resolveWorktreeRootLayout(localPath);
        const usage = await Promise.all(layout.bases.map(async (base) => ({
          count: await countWorktrees(base),
          bytes: await measureBytes(base),
        })));
        const count = usage.reduce((sum, item) => sum + item.count, 0);
        const bytes = usage.reduce((sum, item) => sum + item.bytes, 0);
        if (count === 0 && bytes === 0) return null; // nothing on disk — omit
        return { name: repo.name ?? path.basename(localPath), path: layout.primaryBase, count, bytes };
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
