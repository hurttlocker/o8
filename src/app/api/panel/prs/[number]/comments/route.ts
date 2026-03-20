export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { listRepos } from '@/lib/repos/registry';

const DEFAULT_REPO = process.env.GITHUB_REPO || 'hurttlocker/cortex-ide';

function normalizeRepoSlug(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

async function resolveCandidateRepos(preferredRepo: string) {
  const registered = await listRepos().catch(() => []);
  const candidateRepos = new Set<string>([preferredRepo, DEFAULT_REPO]);
  for (const entry of registered) {
    const slug = normalizeRepoSlug(entry.remoteUrl);
    if (slug) candidateRepos.add(slug);
  }
  return Array.from(candidateRepos).filter((repo) => /^[\w.-]+\/[\w.-]+$/.test(repo));
}

function isMissingPrError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Not Found')
    || message.includes('Could not resolve to a PullRequest')
    || message.includes('pull request not found');
}

interface ReviewComment {
  id: number;
  author: string;
  body: string;
  path: string;
  line: number | null;
  side: string;
  createdAt: string;
  state: string;
  diffHunk: string;
  inReplyTo: number | null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number } = await params;
  const { searchParams } = new URL(request.url);
  const repo = searchParams.get('repo') || DEFAULT_REPO;
  const prNumber = parseInt(number, 10);

  if (isNaN(prNumber)) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  try {
    const candidateRepos = await resolveCandidateRepos(repo);
    let resolvedRepo = repo;
    let loaded = false;

    for (const candidateRepo of candidateRepos) {
      try {
        execSync(
          `gh pr view ${prNumber} --repo ${candidateRepo} --json number`,
          { encoding: 'utf-8', timeout: 10000 },
        );
        resolvedRepo = candidateRepo;
        loaded = true;
        break;
      } catch (error) {
        if (!isMissingPrError(error)) {
          throw error;
        }
      }
    }

    if (!loaded) {
      return NextResponse.json({ comments: [], reviews: [], prNumber, repo }, { status: 200 });
    }

    // Get review comments (inline code comments)
    const commentsJson = execSync(
      `gh api repos/${resolvedRepo}/pulls/${prNumber}/comments --paginate --jq '[.[] | {id: .id, author: .user.login, body: .body, path: .path, line: .line, side: .side, createdAt: .created_at, state: (.state // ""), diffHunk: .diff_hunk, inReplyTo: .in_reply_to_id}]'`,
      { encoding: 'utf-8', timeout: 15000 },
    );

    let comments: ReviewComment[] = [];
    try {
      comments = JSON.parse(commentsJson);
    } catch { /* empty */ }

    // Get reviews (top-level review submissions)
    let reviews: { id: number; author: string; body: string; state: string; submittedAt: string }[] = [];
    try {
      const reviewsJson = execSync(
        `gh api repos/${resolvedRepo}/pulls/${prNumber}/reviews --jq '[.[] | {id: .id, author: .user.login, body: .body, state: .state, submittedAt: .submitted_at}]'`,
        { encoding: 'utf-8', timeout: 10000 },
      );
      reviews = JSON.parse(reviewsJson);
    } catch { /* empty */ }

    return NextResponse.json({ comments, reviews, prNumber, repo: resolvedRepo });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, comments: [], reviews: [] }, { status: 200 });
  }
}
