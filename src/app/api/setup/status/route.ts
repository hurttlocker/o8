import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    {
      ok: true,
      ready: true,
      service: 'o8',
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
