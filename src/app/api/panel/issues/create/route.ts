export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const DEFAULT_REPO = process.env.GITHUB_REPO || 'hurttlocker/cortex-ide';

export async function POST(request: Request) {
  const body = await request.json();
  const { title, description, labels, repo } = body as {
    title: string;
    description?: string;
    labels?: string[];
    repo?: string;
  };

  if (!title?.trim()) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 });
  }

  const repoSlug = repo || DEFAULT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoSlug)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  try {
    const args = ['issue', 'create', '--repo', repoSlug, '--title', title.trim()];

    if (description?.trim()) {
      args.push('--body', description.trim());
    }

    if (labels && labels.length > 0) {
      args.push('--label', labels.join(','));
    }

    const output = execSync(
      `gh ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`,
      { encoding: 'utf-8', timeout: 15000 },
    );

    // gh issue create outputs the URL of the created issue
    const issueUrl = output.trim();
    const issueNumber = parseInt(issueUrl.split('/').pop() ?? '0', 10);

    return NextResponse.json({
      ok: true,
      url: issueUrl,
      number: issueNumber,
      repo: repoSlug,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, ok: false }, { status: 500 });
  }
}
