export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

/**
 * GET /api/panel/repo-info?workspace=<absolute-path>
 *
 * Returns the GitHub owner/repo for a given workspace path.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspace = searchParams.get('workspace');

  if (!workspace) {
    return NextResponse.json({ error: 'workspace param required' }, { status: 400 });
  }

  // Expand ~ to home dir
  const home = process.env.HOME || require('os').homedir();
  const absPath = workspace.startsWith('~') ? workspace.replace('~', home) : workspace;

  if (!existsSync(absPath)) {
    return NextResponse.json({ repo: null, workspace, reason: 'path not found' });
  }

  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: absPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    // Parse owner/repo from various URL formats
    // https://github.com/owner/repo.git
    // git@github.com:owner/repo.git
    let repo: string | null = null;
    const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/.]+)/);
    const sshMatch = remoteUrl.match(/github\.com:([^/]+\/[^/.]+)/);
    if (httpsMatch) repo = httpsMatch[1];
    else if (sshMatch) repo = sshMatch[1];

    return NextResponse.json({ repo, workspace, remoteUrl });
  } catch {
    return NextResponse.json({ repo: null, workspace, reason: 'not a git repo or no remote' });
  }
}
