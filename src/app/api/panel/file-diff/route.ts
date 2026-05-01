export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('path') ?? searchParams.get('file');
  const workspaceParam = searchParams.get('workspace') ?? searchParams.get('repoPath');

  if (!filePath) {
    return NextResponse.json({ error: 'path param required' }, { status: 400 });
  }

  const home = process.env.HOME || require('os').homedir();
  let root = DEFAULT_ROOT;
  if (workspaceParam) {
    root = workspaceParam.startsWith('~') ? workspaceParam.replace('~', home) : workspaceParam;
  }

  try {
    // Get the diff for this specific file (staged + unstaged)
    let diff = '';
    try {
      // Staged + unstaged changes against HEAD.
      diff = execSync(`git diff --no-color HEAD -- "${filePath}"`, {
        cwd: root,
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 512 * 1024,
      });
    } catch { /* no HEAD diff */ }

    // Also check staged changes
    let stagedDiff = '';
    try {
      stagedDiff = diff ? '' : execSync(`git diff --no-color --cached -- "${filePath}"`, {
        cwd: root,
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 512 * 1024,
      });
    } catch { /* no staged diff */ }

    // Check if file is untracked
    let isUntracked = false;
    try {
      const status = execSync(`git status --porcelain -- "${filePath}"`, {
        cwd: root,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      isUntracked = status.startsWith('??');
    } catch { /* silent */ }

    const combinedDiff = [stagedDiff, diff].filter(Boolean).join('\n');

    if (combinedDiff.length > 50000) {
      return NextResponse.json({
        diff: combinedDiff.slice(0, 50000) + '\n\n... (truncated at 50KB)',
        hasDiff: true,
        isUntracked,
        path: filePath,
      });
    }

    return NextResponse.json({
      diff: combinedDiff,
      hasDiff: combinedDiff.length > 0,
      isUntracked,
      path: filePath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
