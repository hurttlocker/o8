import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import path from 'path';

export const dynamic = 'force-dynamic';

interface BranchInfo {
  name: string;
  current: boolean;
  lastCommitAge: string;
  lastCommitMessage: string;
  lastCommitUnix: number;
  isWorktree: boolean;
  worktreePath?: string;
  ahead: number;
  behind: number;
  isStale: boolean;
  staleDays?: number;
  diskSize?: string;
}

const STALE_THRESHOLD_DAYS = 3;

export async function GET(req: NextRequest) {
  const repoPath = req.nextUrl.searchParams.get('path');
  if (!repoPath) {
    return NextResponse.json({ error: 'path parameter required' }, { status: 400 });
  }

  try {
    // Get all local branches with details
    const branchRaw = execSync(
      `git -C "${repoPath}" for-each-ref --sort=-committerdate refs/heads/ --format='%(refname:short)|||%(committerdate:relative)|||%(subject)|||%(HEAD)|||%(committerdate:unix)'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();

    // Get worktree list
    let worktrees: Map<string, string> = new Map();
    try {
      const wtRaw = execSync(
        `git -C "${repoPath}" worktree list --porcelain`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      let currentPath = '';
      for (const line of wtRaw.split('\n')) {
        if (line.startsWith('worktree ')) currentPath = line.slice(9);
        if (line.startsWith('branch refs/heads/')) {
          worktrees.set(line.slice(18), currentPath);
        }
      }
    } catch { /* no worktrees */ }

    const branches: BranchInfo[] = [];
    const now = Date.now();
    for (const line of branchRaw.split('\n').filter(Boolean)) {
      const [name, age, message, head, unixStr] = line.split('|||');
      if (!name) continue;

      const trimmedName = name.trim();
      const commitUnix = parseInt(unixStr?.trim() ?? '0', 10) * 1000;
      const daysSinceCommit = Math.floor((now - commitUnix) / (1000 * 60 * 60 * 24));
      const isCurrent = head?.trim() === '*';
      const isWt = worktrees.has(trimmedName);

      // Get ahead/behind vs origin
      let ahead = 0, behind = 0;
      try {
        const ab = execSync(
          `git -C "${repoPath}" rev-list --left-right --count origin/${trimmedName}...${trimmedName} 2>/dev/null`,
          { encoding: 'utf-8', timeout: 3000 },
        ).trim();
        const [b, a] = ab.split('\t').map(Number);
        ahead = a || 0;
        behind = b || 0;
      } catch { /* no remote tracking */ }

      // Disk size for worktrees
      let diskSize: string | undefined;
      if (isWt && worktrees.get(trimmedName)) {
        try {
          diskSize = execSync(
            `du -sh "${worktrees.get(trimmedName)}" 2>/dev/null | cut -f1`,
            { encoding: 'utf-8', timeout: 3000 },
          ).trim();
        } catch { /* ignore */ }
      }

      branches.push({
        name: trimmedName,
        current: isCurrent,
        lastCommitAge: age?.trim() ?? '',
        lastCommitMessage: (message?.trim() ?? '').split('\n')[0],
        lastCommitUnix: commitUnix,
        isWorktree: isWt,
        worktreePath: worktrees.get(trimmedName),
        ahead,
        behind,
        isStale: !isCurrent && daysSinceCommit >= STALE_THRESHOLD_DAYS,
        staleDays: !isCurrent && daysSinceCommit >= STALE_THRESHOLD_DAYS ? daysSinceCommit : undefined,
        diskSize,
      });
    }

    return NextResponse.json({ branches, repoPath });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list branches', branches: [] },
      { status: 500 },
    );
  }
}
