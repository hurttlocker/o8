export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { createGitHubPullRequest, findGitHubPullRequestByHead, normalizeRepoSlug } from '@/lib/github-broker';

const execFileAsync = promisify(execFile);

async function detectRepoSlug(cwd: string) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
    return normalizeRepoSlug(stdout.trim());
  } catch {
    return null;
  }
}

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

    const cwd = repoPath.replace(/^~/, process.env.HOME || os.homedir());

    const repoSlug = await detectRepoSlug(cwd);
    if (!repoSlug) {
      return NextResponse.json({ error: 'Unable to resolve GitHub repo for this branch.' }, { status: 400 });
    }

    const existing = await findGitHubPullRequestByHead(repoSlug, branch).catch(() => null);
    if (existing) {
      return NextResponse.json({
        exists: true,
        pr: existing,
      });
    }

    try {
      const prTitle = title || `feat: ${branch.replace(/[-_]/g, ' ')}`;
      const created = await createGitHubPullRequest(repoSlug, {
        head: branch,
        base,
        title: prTitle,
        body: prBody,
        draft,
      });

      return NextResponse.json({
        created: true,
        url: created.url,
        number: created.number,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
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
