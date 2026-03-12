import { NextRequest, NextResponse } from 'next/server';
import { steerOpenClawSession } from '@/lib/openclaw/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as
    | {
        sessionKey?: string;
        message?: string;
      }
    | null;

  const sessionKey = payload?.sessionKey?.trim();
  const message = payload?.message?.trim();

  if (!sessionKey || !message) {
    return NextResponse.json({ error: 'sessionKey and message are required' }, { status: 400 });
  }

  try {
    const result = await steerOpenClawSession(sessionKey, message);
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to steer session',
      },
      { status: 500 },
    );
  }
}
