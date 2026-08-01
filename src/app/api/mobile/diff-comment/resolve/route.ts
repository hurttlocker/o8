/**
 * Resolve an inline diff comment — the agent addressed it or
 * the operator dismissed it. Gated like the rest of /api/mobile/*.
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { resolveDiffComment } from '@/lib/mobile/diff-comments';

interface Body {
  commentId?: unknown;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const commentId = typeof body.commentId === 'string' ? body.commentId.trim() : '';
  if (!commentId) {
    return NextResponse.json({ error: 'commentId required' }, { status: 400 });
  }
  return NextResponse.json({ resolved: resolveDiffComment(commentId) });
}
