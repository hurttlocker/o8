import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { WorktreeInfo } from '@/lib/worktree/types';

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
  additions: number;
  deletions: number;
  isStale: boolean;
  staleDays?: number;
  diskSize?: string;
}

const STALE_THRESHOLD_DAYS = 3;

function parseShortstat(raw: string): { additions: number; deletions: number } {
  // Format: " 5 files changed, 518 insertions(+), 169 deletions(-)"
  // Either insertions or deletions may be missing when one side is zero.
  const insMatch = raw.match(/(\d+)\s+insertion/);
  const delMatch = raw.match(/(\d+)\s+deletion/);
  return {
    additions: insMatch ? parseInt(insMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
  };
}

function diskSizeForPath(targetPath: string): string | undefined {
  try {
    return execSync(
      `du -sh "${targetPath}" 2>/dev/null | cut -f1`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
  } catch {
    return undefined;
  }
}

function gitLogSummary(repoPath: string): { age: string; message: string; unixMs: number } {
  try {
    const raw = execSync(
      `git -C "${repoPath}" log -1 --format='%cr|||%s|||%ct'`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    const [age, message, unixStr] = raw.split('|||');
    return {
      age: age?.trim() ?? '',
      message: (message?.trim() ?? '').split('\n')[0],
      unixMs: parseInt(unixStr?.trim() ?? '0', 10) * 1000,
    };
  } catch {
    return { age: '', message: '', unixMs: 0 };
  }
}

function worktreeDiffStats(worktree: WorktreeInfo): { additions: number; deletions: number } {
  const refs = [
    `origin/${worktree.baseBranch}...HEAD`,
    `${worktree.baseBranch}...HEAD`,
  ];

  for (const ref of refs) {
    try {
      const stats = execSync(
        `git -C "${worktree.path}" diff --shortstat ${ref} 2>/dev/null`,
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();
      if (stats) return parseShortstat(stats);
      return { additions: 0, deletions: 0 };
    } catch {
      // Try the next ref shape.
    }
  }

  return { additions: 0, deletions: 0 };
}

export async function GET(req: NextRequest) {
  const repoPath = req.nextUrl.searchParams.get('path');
  if (!repoPath) {
    return NextResponse.json({ error: 'path parameter required' }, { status: 400 });
  }

  try {
    // Resolve the default branch once so we can diff every branch against it.
    // Prefer origin/HEAD symbolic ref; fall back to main, then master.
    let defaultBranch = 'main';
    try {
      const symbolic = execSync(
        `git -C "${repoPath}" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null`,
        { encoding: 'utf-8', timeout: 2000 },
      ).trim();
      if (symbolic.startsWith('origin/')) {
        defaultBranch = symbolic.slice('origin/'.length);
      }
    } catch {
      try {
        execSync(`git -C "${repoPath}" rev-parse --verify master 2>/dev/null`, { encoding: 'utf-8', timeout: 2000 });
        defaultBranch = 'master';
      } catch { /* keep 'main' */ }
    }

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

    const trackedWorktrees = await getWorktreeManager(repoPath).list().catch(() => [] as WorktreeInfo[]);
    for (const worktree of trackedWorktrees) {
      worktrees.set(worktree.branch, worktree.path);
    }

    const branches: BranchInfo[] = [];
    const branchNames = new Set<string>();
    const now = Date.now();
    for (const line of branchRaw.split('\n').filter(Boolean)) {
      const [name, age, message, head, unixStr] = line.split('|||');
      if (!name) continue;

      const trimmedName = name.trim();
      const commitUnix = parseInt(unixStr?.trim() ?? '0', 10) * 1000;
      const daysSinceCommit = Math.floor((now - commitUnix) / (1000 * 60 * 60 * 24));
      const isCurrent = head?.trim() === '*';
      const isWt = worktrees.has(trimmedName);

      // Orphaned managed-worktree branches pollute the sidebar with dead rows
      // for lanes that finished long ago. The `worktree/` prefix is our own
      // convention for codex/claude-code scratch branches — once the worktree
      // is gone, the ref exists only because git doesn't auto-prune it.
      if (!isCurrent && !isWt && trimmedName.startsWith('worktree/')) {
        continue;
      }

      // `worktree-agent-*` is the Claude harness's internal worktree-branch
      // naming convention for sub-agent runs. They are never user-facing
      // workspaces — hide them unconditionally so the sidebar doesn't
      // accumulate one row per completed sub-agent.
      if (trimmedName.startsWith('worktree-agent-')) {
        continue;
      }

      // Claude harness sub-agent worktrees check out real feature branches
      // (e.g. polish/hit-zone-approvals) into `.claude/worktrees/agent-XXX/`
      // dirs that the harness creates per sub-agent run and never cleans up.
      // The branch ref + worktree dir survive long after the sub-agent
      // completes, leaking 30+ stale rows into the sidebar. Detect them by
      // worktree-path convention (we already know it's a worktree from the
      // git porcelain parse above) and skip — the user only ever wants to
      // see worktrees they created via the o8 workspace flow, not the ones
      // Claude's sub-agent feature spawned. Closes #750. The path check is
      // a substring match because git reports paths verbatim from the
      // porcelain output, including the repo's own basename — `endsWith`
      // would miss nested cases. The active checkout (`isCurrent`) is
      // never under .claude/worktrees/agent-* in practice but we preserve
      // it defensively in case a power-user is daily-driving from one.
      if (!isCurrent && isWt) {
        const worktreePath = worktrees.get(trimmedName) ?? '';
        if (worktreePath.includes('/.claude/worktrees/agent-')) {
          continue;
        }
      }

      // Hide branches whose working diff vs default branch is empty — i.e.
      // every change on the branch already exists on default. Catches BOTH
      // fast-forward / regular merges AND squash merges (where the branch
      // tip is NOT an ancestor of default but the diff is still empty).
      // `git diff --quiet A..B` exits 0 when no diff, 1 when there is diff,
      // 128 on missing ref. Treat exit 0 as "merged → drop".
      if (!isCurrent && !isWt && trimmedName !== defaultBranch) {
        try {
          execSync(
            `git -C "${repoPath}" diff --quiet "${defaultBranch}".."${trimmedName}"`,
            { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' },
          );
          // Exit 0 → no diff → branch is fully landed on default.
          continue;
        } catch {
          // Non-zero exit (has diff, or missing ref) → keep the branch.
        }
      }

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

      // Diff stats vs the default branch. Skipped when the branch IS the
      // default (a no-op diff) or when the command fails (stale ref etc.).
      let additions = 0, deletions = 0;
      if (trimmedName !== defaultBranch) {
        try {
          const stats = execSync(
            `git -C "${repoPath}" diff --shortstat ${defaultBranch}...${trimmedName} 2>/dev/null`,
            { encoding: 'utf-8', timeout: 3000 },
          ).trim();
          if (stats) ({ additions, deletions } = parseShortstat(stats));
        } catch { /* no merge base / missing ref */ }
      }

      // Disk size for worktrees
      let diskSize: string | undefined;
      if (isWt && worktrees.get(trimmedName)) {
        diskSize = diskSizeForPath(worktrees.get(trimmedName)!);
      }

      branchNames.add(trimmedName);
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
        additions,
        deletions,
        isStale: !isCurrent && daysSinceCommit >= STALE_THRESHOLD_DAYS,
        staleDays: !isCurrent && daysSinceCommit >= STALE_THRESHOLD_DAYS ? daysSinceCommit : undefined,
        diskSize,
      });
    }

    for (const worktree of trackedWorktrees) {
      if (branchNames.has(worktree.branch)) continue;
      branchNames.add(worktree.branch);

      const log = gitLogSummary(worktree.path);
      const commitUnix = log.unixMs || worktree.createdAt;
      const daysSinceCommit = Math.floor((now - commitUnix) / (1000 * 60 * 60 * 24));
      const diff = worktreeDiffStats(worktree);

      branches.push({
        name: worktree.branch,
        current: false,
        lastCommitAge: log.age || '',
        lastCommitMessage: log.message,
        lastCommitUnix: commitUnix,
        isWorktree: true,
        worktreePath: worktree.path,
        ahead: 0,
        behind: 0,
        additions: diff.additions,
        deletions: diff.deletions,
        isStale: worktree.status === 'stale' || daysSinceCommit >= STALE_THRESHOLD_DAYS,
        staleDays: daysSinceCommit >= STALE_THRESHOLD_DAYS ? daysSinceCommit : undefined,
        diskSize: diskSizeForPath(worktree.path),
      });
    }

    branches.sort((a, b) => b.lastCommitUnix - a.lastCommitUnix);

    return NextResponse.json({ branches, repoPath });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list branches', branches: [] },
      { status: 500 },
    );
  }
}

// ── DELETE: Remove branch (+ worktree if applicable) ──
//
// Local-only by default. The sidebar prune UI never deletes the remote ref —
// pass `deleteRemote: true` only when the caller explicitly opts in (a future
// "delete remote too" toggle). See #720 for the rationale: the prune gesture
// is for tidying the local sidebar, not for force-publishing branch removal.
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json() as { path: string; branch: string; force?: boolean; deleteRemote?: boolean };
    const { path: repoPath, branch, force, deleteRemote } = body;

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

    // Optionally delete the remote branch — opt-in only. Local prune does not
    // touch origin so a YC-reviewer-style "tidy my sidebar" click can't
    // accidentally drop a remote ref another collaborator is depending on.
    let remoteDeleted = false;
    if (deleteRemote) {
      try {
        execSync(`git -C "${repoPath}" push origin --delete "${branch}" 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 10000,
        });
        remoteDeleted = true;
      } catch { /* no remote branch or no permission */ }
    }

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
