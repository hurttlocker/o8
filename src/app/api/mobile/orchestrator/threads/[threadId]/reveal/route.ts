import { NextResponse } from 'next/server';
import { requestMobileOrchestratorReveal } from '@/lib/mobile/orchestrator-thread-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function POST(
  _request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  if (!threadId?.trim()) {
    return NextResponse.json({ error: 'threadId is required' }, { status: 400, headers: NO_STORE });
  }

  const request = requestMobileOrchestratorReveal(threadId);
  if (!request) {
    return NextResponse.json({ error: 'thread not found' }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json(request, { headers: NO_STORE });
}
