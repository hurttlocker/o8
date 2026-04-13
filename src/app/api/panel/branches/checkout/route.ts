export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      repoPath: string;
      branch: string;
      stash?: boolean;
      force?: boolean;
    };

    const { repoPath, branch, stash, force } = body;
    if (!repoPath || !branch) {
      return NextResponse.json({ error: 'repoPath and branch required' }, { status: 400 });
    }

    const cwd = repoPath.replace(/^~/, process.env.HOME || require('os').homedir());

    // Check for uncommitted changes
    let dirty = false;
    let dirtyFiles: string[] = [];
    try {
      const status = execSync('git status --porcelain', { cwd, timeout: 5000 }).toString().trim();
      if (status) {
        dirty = true;
        dirtyFiles = status.split('\n').slice(0, 10); // First 10 files
      }
    } catch {
      return NextResponse.json({ error: 'Failed to check git status' }, { status: 500 });
    }

    // If dirty and no stash/force requested, return warning
    if (dirty && !stash && !force) {
      return NextResponse.json({
        error: 'uncommitted_changes',
        dirty: true,
        fileCount: dirtyFiles.length,
        files: dirtyFiles,
        message: `${dirtyFiles.length} uncommitted change${dirtyFiles.length === 1 ? '' : 's'}. Stash or force checkout?`,
      }, { status: 409 });
    }

    // Stash if requested
    if (dirty && stash) {
      try {
        execSync(`git stash push -m "o8: auto-stash before switching to ${branch}"`, {
          cwd, timeout: 10000,
        });
      } catch (err) {
        return NextResponse.json({
          error: `Stash failed: ${err instanceof Error ? err.message : 'unknown'}`,
        }, { status: 500 });
      }
    }

    // Checkout
    try {
      const forceFlag = force ? ' -f' : '';
      execSync(`git checkout${forceFlag} ${JSON.stringify(branch)}`, {
        cwd, timeout: 10000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      return NextResponse.json({
        error: `Checkout failed: ${msg}`,
      }, { status: 500 });
    }

    // Verify current branch
    let currentBranch = branch;
    try {
      currentBranch = execSync('git branch --show-current', { cwd, timeout: 5000 }).toString().trim();
    } catch { /* use requested branch */ }

    return NextResponse.json({
      success: true,
      branch: currentBranch,
      stashed: Boolean(dirty && stash),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to checkout' },
      { status: 500 },
    );
  }
}
