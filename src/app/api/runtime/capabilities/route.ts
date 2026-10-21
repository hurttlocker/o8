import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getRuntime } from '@/lib/runtimes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Adapter declarations only: no CLI, account probe, session or inference is started. */
export function GET(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  const id = request.nextUrl.searchParams.get('id') ?? '';
  const adapter = getRuntime(id);
  return NextResponse.json({ id, capabilities: adapter?.capabilities ?? null }, { headers: { 'Cache-Control': 'no-store' } });
}
