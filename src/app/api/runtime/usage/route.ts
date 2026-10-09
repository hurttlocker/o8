import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getUsageHistoryState } from '@/lib/usage/history-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  const days = Number(request.nextUrl.searchParams.get('days') ?? 30);
  const timeZone = request.nextUrl.searchParams.get('timeZone') ?? 'UTC';
  if (![1, 7, 30, 90].includes(days)) return NextResponse.json({ error: 'Choose a supported usage range.' }, { status: 400 });
  try { new Intl.DateTimeFormat('en', { timeZone }); }
  catch { return NextResponse.json({ error: 'Choose a valid time zone.' }, { status: 400 }); }
  try {
    const state = getUsageHistoryState({ days: days as 1 | 7 | 30 | 90, timeZone,
      fresh: request.nextUrl.searchParams.get('fresh') === '1' });
    if (state.snapshot) return NextResponse.json({ ...state.snapshot, refreshing: state.pending,
      refreshFailed: state.error }, { headers: { 'Cache-Control': 'no-store' } });
    if (state.error) return NextResponse.json({ error: 'Local history could not be read.' }, { status: 503 });
    return NextResponse.json({ schema: 'o8/usage-history-state/v1', status: 'scanning', startedAt: state.startedAt },
      { status: 202, headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' } });
  } catch {
    return NextResponse.json({ error: 'Local usage history could not be read. Previous observations remain visible.' }, { status: 503 });
  }
}
