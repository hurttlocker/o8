import { NextRequest, NextResponse } from 'next/server';
import { abortOpenClawSession } from '@/lib/openclaw/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as
    | {
        sessionKey?: string;
        runId?: string;
      }
    | null;

  const sessionKey = payload?.sessionKey?.trim();
  const runId = payload?.runId?.trim();

  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400 });
  }

  try {
    const result = await abortOpenClawSession(sessionKey, runId);
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to stop session',
      },
      { status: 500 },
    );
  }
}
