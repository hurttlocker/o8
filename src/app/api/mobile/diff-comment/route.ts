/**
 * Create an inline diff comment. The phone anchors a note to
 * a file + line of an agent session's diff. Gated like the rest of /api/mobile/*
 * (a paired phone's per-device token or the loopback desktop). Contract:
 * docs/internals/mobile-diff-comments.md.
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { createDiffComment, type DiffCommentSide } from '@/lib/mobile/diff-comments';

interface Body {
  sessionKey?: unknown;
  path?: unknown;
  lineNumber?: unknown;
  side?: unknown;
  text?: unknown;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey : '';
  const path = typeof body.path === 'string' ? body.path : '';
  const text = typeof body.text === 'string' ? body.text : '';
  const side: DiffCommentSide = body.side === 'old' ? 'old' : 'new';
  const lineNumber = typeof body.lineNumber === 'number' ? body.lineNumber : Number(body.lineNumber);

  const comment = createDiffComment({ sessionKey, path, lineNumber, side, text });
  if (!comment) {
    return NextResponse.json(
      { error: 'sessionKey, path, text, and a valid lineNumber are required' },
      { status: 400 },
    );
  }
  return NextResponse.json({ comment });
}
