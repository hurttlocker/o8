import { NextResponse } from 'next/server';
import { checkCliUpdates } from '@/lib/setup/cli-updates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const refresh = new URL(request.url).searchParams.get('refresh') === '1';
    return NextResponse.json({ tools: await checkCliUpdates(refresh), checkedAt: new Date().toISOString() });
  } catch {
    return NextResponse.json({ error: 'Unable to check CLI updates.' }, { status: 503 });
  }
}
