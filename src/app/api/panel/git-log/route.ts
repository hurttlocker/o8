export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceParam = searchParams.get('workspace');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '40', 10), 100);
  const branch = searchParams.get('branch');

  const home = process.env.HOME || require('os').homedir();
  let root = DEFAULT_ROOT;
  if (workspaceParam) {
    root = workspaceParam.startsWith('~') ? workspaceParam.replace('~', home) : workspaceParam;
  }

  try {
    const branchArg = branch ? ` ${branch}` : '';
    const logOutput = execSync(
      `git log --format='{"hash":"%H","shortHash":"%h","author":"%an","authorEmail":"%ae","date":"%aI","subject":"%s","refs":"%D"}' -n ${limit}${branchArg}`,
      { cwd: root, encoding: 'utf-8', timeout: 10000 },
    );

    const commits = logOutput.trim().split('\n').filter(Boolean).map(line => {
      try {
        const parsed = JSON.parse(line);
        // Parse refs into structured data
        const refs: { type: string; name: string }[] = [];
        if (parsed.refs) {
          for (const ref of parsed.refs.split(', ').filter(Boolean)) {
            if (ref.startsWith('HEAD -> ')) {
              refs.push({ type: 'head', name: ref.replace('HEAD -> ', '') });
            } else if (ref.startsWith('tag: ')) {
              refs.push({ type: 'tag', name: ref.replace('tag: ', '') });
            } else if (ref.includes('/')) {
              refs.push({ type: 'remote', name: ref });
            } else {
              refs.push({ type: 'branch', name: ref });
            }
          }
        }
        return { ...parsed, refs };
      } catch {
        return null;
      }
    }).filter(Boolean);

    // Get current branch
    let currentBranch = 'main';
    try {
      currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: root, encoding: 'utf-8', timeout: 3000,
      }).trim();
    } catch { /* silent */ }

    // Get branch list
    let branches: string[] = [];
    try {
      branches = execSync('git branch --format="%(refname:short)" | head -20', {
        cwd: root, encoding: 'utf-8', timeout: 3000,
      }).trim().split('\n').filter(Boolean);
    } catch { /* silent */ }

    return NextResponse.json({ commits, currentBranch, branches });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, commits: [], currentBranch: 'main', branches: [] });
  }
}
