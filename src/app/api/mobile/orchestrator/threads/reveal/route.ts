import { NextResponse, type NextRequest } from 'next/server';
import { listMobileOrchestratorRevealRequests } from '@/lib/mobile/orchestrator-thread-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET(request: NextRequest) {
  try {
    const since = request.nextUrl.searchParams.get('since');
    const requests = listMobileOrchestratorRevealRequests(since);
    return NextResponse.json({ requests }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read reveal requests.';
    return NextResponse.json({ error: message, requests: [] }, { status: 500, headers: NO_STORE });
  }
}
