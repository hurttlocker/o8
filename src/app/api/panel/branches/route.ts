import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';

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
    const worktrees: Map<string, string> = new Map();
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

// ── DELETE: Remove branch (+ worktree if applicable) ──
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json() as { path: string; branch: string; force?: boolean };
    const { path: repoPath, branch, force } = body;

    if (!repoPath || !branch) {
      return NextResponse.json({ error: 'path and branch required' }, { status: 400 });
    }

    // Prevent deleting main/master
    const protectedBranches = ['main', 'master', 'develop'];
    if (protectedBranches.includes(branch)) {
      return NextResponse.json({ error: `Cannot delete protected branch '${branch}'` }, { status: 400 });
    }

    // Check if it's a worktree — remove worktree first
    let worktreeRemoved = false;
    try {
      const wtRaw = execSync(
        `git -C "${repoPath}" worktree list --porcelain`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      let currentPath = '';
      for (const line of wtRaw.split('\n')) {
        if (line.startsWith('worktree ')) currentPath = line.slice(9);
        if (line.startsWith('branch refs/heads/') && line.slice(18) === branch && currentPath !== repoPath) {
          // Remove the worktree
          execSync(`git -C "${repoPath}" worktree remove "${currentPath}" ${force ? '--force' : ''}`, {
            encoding: 'utf-8',
            timeout: 10000,
          });
          worktreeRemoved = true;
          break;
        }
      }
    } catch { /* no worktree to remove */ }

    // Delete the branch
    const flag = force ? '-D' : '-d';
    execSync(`git -C "${repoPath}" branch ${flag} "${branch}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });

    // Try to delete remote branch too
    let remoteDeleted = false;
    try {
      execSync(`git -C "${repoPath}" push origin --delete "${branch}" 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 10000,
      });
      remoteDeleted = true;
    } catch { /* no remote branch or no permission */ }

    return NextResponse.json({
      deleted: branch,
      worktreeRemoved,
      remoteDeleted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to delete branch';
    // If branch not fully merged, suggest force
    if (msg.includes('not fully merged')) {
      return NextResponse.json({
        error: `Branch '${(await req.clone().json() as { branch: string }).branch}' is not fully merged. Use force delete?`,
        canForce: true,
      }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── POST: Create new branch (+ optional worktree) ──
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { path: string; branch: string; baseBranch?: string; worktree?: boolean };
    const { path: repoPath, branch, baseBranch, worktree } = body;

    if (!repoPath || !branch) {
      return NextResponse.json({ error: 'path and branch required' }, { status: 400 });
    }

    // Validate branch name
    const safeNameRe = /^[a-zA-Z0-9._\-/]+$/;
    if (!safeNameRe.test(branch)) {
      return NextResponse.json({ error: 'Invalid branch name' }, { status: 400 });
    }

    const base = baseBranch || 'main';

    if (worktree) {
      // Create worktree with new branch
      const worktreePath = `${repoPath}/../.worktrees/${branch.replace(/\//g, '-')}`;
      execSync(
        `git -C "${repoPath}" worktree add "${worktreePath}" -b "${branch}" "${base}"`,
        { encoding: 'utf-8', timeout: 10000 },
      );
      return NextResponse.json({
        created: branch,
        baseBranch: base,
        isWorktree: true,
        worktreePath,
      });
    } else {
      // Just create branch
      execSync(
        `git -C "${repoPath}" branch "${branch}" "${base}"`,
        { encoding: 'utf-8', timeout: 5000 },
      );
      return NextResponse.json({
        created: branch,
        baseBranch: base,
        isWorktree: false,
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create branch' },
      { status: 500 },
    );
  }
}
