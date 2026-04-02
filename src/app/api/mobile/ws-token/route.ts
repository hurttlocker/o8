import { NextResponse } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { token: getOrCreateWsToken() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
