export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceParam = searchParams.get('workspace');
  const filter = searchParams.get('filter') ?? 'uncommitted';

  const home = require('os').homedir();
  const root = workspaceParam
    ? (workspaceParam.startsWith('~') ? workspaceParam.replace('~', home) : workspaceParam)
    : process.cwd();

  try {
    let cmd: string;
    switch (filter) {
      case 'staged':
        cmd = 'git diff --cached --numstat';
        break;
      case 'unstaged':
        cmd = 'git diff --numstat';
        break;
      case 'branch':
        // Changes between current branch and main/master
        cmd = 'git diff main...HEAD --numstat 2>/dev/null || git diff master...HEAD --numstat 2>/dev/null || echo ""';
        break;
      case 'uncommitted':
      default:
        // Both staged + unstaged
        cmd = 'git diff HEAD --numstat 2>/dev/null || git diff --numstat';
        break;
    }

    const output = execSync(cmd, { windowsHide: true, cwd: root, encoding: 'utf-8', timeout: 10000, maxBuffer: 256 * 1024 }).trim();

    const files = output.split('\n').filter(Boolean).map((line) => {
      const [addStr, delStr, ...pathParts] = line.split('\t');
      const path = pathParts.join('\t');
      const additions = addStr === '-' ? 0 : parseInt(addStr, 10) || 0;
      const deletions = delStr === '-' ? 0 : parseInt(delStr, 10) || 0;

      // Determine status
      let status = 'modified';
      if (additions > 0 && deletions === 0) status = 'added';
      if (additions === 0 && deletions > 0) status = 'deleted';

      return { path, status, additions, deletions, staged: filter === 'staged' };
    });

    return NextResponse.json({ files, filter, workspace: root });
  } catch (err) {
    return NextResponse.json({
      files: [],
      filter,
      workspace: root,
      error: err instanceof Error ? err.message : 'Failed to get git status',
    });
  }
}
