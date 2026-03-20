import { NextRequest, NextResponse } from 'next/server';
import { getSessionTranscript } from '@/lib/openclaw/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim();
  const rawLimit = request.nextUrl.searchParams.get('limit');
  const fresh = request.nextUrl.searchParams.get('fresh') === '1';
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 12;
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 30) : 12;

  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400 });
  }

  try {
    const transcript = await getSessionTranscript(sessionKey, limit, fresh);
    return NextResponse.json(
      {
        sessionKey,
        transcript,
      },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to load session transcript',
      },
      { status: 500 },
    );
  }
}
