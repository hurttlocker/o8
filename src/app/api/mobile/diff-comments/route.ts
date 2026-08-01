/**
 * List inline diff comments for an agent session. The phone
 * fetches these to render line markers; the desktop review surface reads them
 * too. Gated like the rest of /api/mobile/*. Contract: docs/internals/mobile-diff-comments.md.
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { listDiffComments } from '@/lib/mobile/diff-comments';

export async function GET(req: NextRequest) {
  const sessionKey = req.nextUrl.searchParams.get('sessionKey')?.trim() ?? '';
  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey required' }, { status: 400 });
  }
  const openOnly = req.nextUrl.searchParams.get('openOnly') === '1';
  try {
    return NextResponse.json({ comments: listDiffComments(sessionKey, { openOnly }) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list comments' },
      { status: 500 },
    );
  }
}
