export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const DEFAULT_REPO = process.env.GITHUB_REPO || 'hurttlocker/cortex-ide';

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
    // Get review comments (inline code comments)
    const commentsJson = execSync(
      `gh api repos/${repo}/pulls/${prNumber}/comments --paginate --jq '[.[] | {id: .id, author: .user.login, body: .body, path: .path, line: .line, side: .side, createdAt: .created_at, state: (.state // ""), diffHunk: .diff_hunk, inReplyTo: .in_reply_to_id}]'`,
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
        `gh api repos/${repo}/pulls/${prNumber}/reviews --jq '[.[] | {id: .id, author: .user.login, body: .body, state: .state, submittedAt: .submitted_at}]'`,
        { encoding: 'utf-8', timeout: 10000 },
      );
      reviews = JSON.parse(reviewsJson);
    } catch { /* empty */ }

    return NextResponse.json({ comments, reviews, prNumber, repo });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, comments: [], reviews: [] }, { status: 200 });
  }
}
