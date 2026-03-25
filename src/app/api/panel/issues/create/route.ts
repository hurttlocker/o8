export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createGitHubIssue, resolveRepoSlug } from '@/lib/github-broker';

const DEFAULT_REPO = process.env.GITHUB_REPO || process.env.CORTEX_IDE_REVIEW_REPO || '';

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

  const repoSlug = await resolveRepoSlug(repo || null, DEFAULT_REPO);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoSlug)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  try {
    const issue = await createGitHubIssue(repoSlug, {
      title: title.trim(),
      body: description?.trim() || '',
      labels: labels?.filter(Boolean) ?? [],
    });

    return NextResponse.json({
      ok: true,
      url: issue.url,
      number: issue.number,
      repo: repoSlug,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, ok: false }, { status: 500 });
  }
}
