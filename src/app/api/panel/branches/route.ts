import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import path from 'path';

export const dynamic = 'force-dynamic';

interface BranchInfo {
  name: string;
  current: boolean;
  lastCommitAge: string;
  lastCommitMessage: string;
  isWorktree: boolean;
  worktreePath?: string;
  ahead: number;
  behind: number;
}

export async function GET(req: NextRequest) {
  const repoPath = req.nextUrl.searchParams.get('path');
  if (!repoPath) {
    return NextResponse.json({ error: 'path parameter required' }, { status: 400 });
  }

  try {
    // Get all local branches with details
    const branchRaw = execSync(
      `git -C "${repoPath}" for-each-ref --sort=-committerdate refs/heads/ --format='%(refname:short)|||%(committerdate:relative)|||%(subject)|||%(HEAD)'`,
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
    for (const line of branchRaw.split('\n').filter(Boolean)) {
      const [name, age, message, head] = line.split('|||');
      if (!name) continue;

      // Get ahead/behind vs origin
      let ahead = 0, behind = 0;
      try {
        const ab = execSync(
          `git -C "${repoPath}" rev-list --left-right --count origin/${name}...${name} 2>/dev/null`,
          { encoding: 'utf-8', timeout: 3000 },
        ).trim();
        const [b, a] = ab.split('\t').map(Number);
        ahead = a || 0;
        behind = b || 0;
      } catch { /* no remote tracking */ }

      branches.push({
        name: name.trim(),
        current: head?.trim() === '*',
        lastCommitAge: age?.trim() ?? '',
        lastCommitMessage: (message?.trim() ?? '').split('\n')[0],
        isWorktree: worktrees.has(name.trim()),
        worktreePath: worktrees.get(name.trim()),
        ahead,
        behind,
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
