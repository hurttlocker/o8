import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sessionKey = searchParams.get('sessionKey');

  if (!sessionKey) {
    return NextResponse.json({ error: 'Missing sessionKey' }, { status: 400 });
  }

  return NextResponse.json({
    media: [],
    total: 0,
    servable: 0,
    sessionKey,
  });
}
