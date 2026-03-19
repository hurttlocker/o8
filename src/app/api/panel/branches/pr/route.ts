export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';

// Create a PR from a branch via gh CLI
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      repoPath: string;
      branch: string;
      title?: string;
      body?: string;
      base?: string;
      draft?: boolean;
    };

    const { repoPath, branch, title, body: prBody, base, draft } = body;
    if (!repoPath || !branch) {
      return NextResponse.json({ error: 'repoPath and branch required' }, { status: 400 });
    }

    const cwd = repoPath.replace(/^~/, process.env.HOME || '/Users/marquisehurtt');

    // Check if PR already exists for this branch
    try {
      const existing = execSync(
        `gh pr list --head ${JSON.stringify(branch)} --json number,title,url,state --limit 1`,
        { cwd, timeout: 10000 },
      ).toString().trim();
      const prs = JSON.parse(existing || '[]');
      if (prs.length > 0) {
        return NextResponse.json({
          exists: true,
          pr: prs[0],
        });
      }
    } catch {
      // gh might not be configured, continue to create
    }

    // Build command
    const prTitle = title || `feat: ${branch.replace(/[-_]/g, ' ')}`;
    const parts = ['gh', 'pr', 'create',
      '--head', JSON.stringify(branch),
      '--title', JSON.stringify(prTitle),
    ];
    if (base) parts.push('--base', JSON.stringify(base));
    if (prBody) parts.push('--body', JSON.stringify(prBody));
    else parts.push('--body', '""');
    if (draft) parts.push('--draft');

    const cmd = parts.join(' ');

    try {
      const result = execSync(cmd, { cwd, timeout: 15000 }).toString().trim();
      // gh pr create returns the URL
      const urlMatch = result.match(/https:\/\/github\.com\/[^\s]+/);
      const numberMatch = result.match(/\/pull\/(\d+)/);

      return NextResponse.json({
        created: true,
        url: urlMatch?.[0] ?? result,
        number: numberMatch ? parseInt(numberMatch[1], 10) : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      // Check for "already exists" error
      if (msg.includes('already exists')) {
        return NextResponse.json({
          error: 'PR already exists for this branch',
          exists: true,
        }, { status: 409 });
      }
      return NextResponse.json({ error: `PR creation failed: ${msg}` }, { status: 500 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create PR' },
      { status: 500 },
    );
  }
}
