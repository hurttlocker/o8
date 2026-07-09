export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { resolvePortInfo } from '@/lib/panel/api-port';

/** GET — list alive dashboard terminal sessions owned by the WS bridge */
export async function GET() {
  try {
    const wsToken = getOrCreateWsToken();
    const { wsPort } = resolvePortInfo();
    const response = await fetch(`http://127.0.0.1:${wsPort}/terminal-sessions`, {
      headers: { Authorization: `Bearer ${wsToken}` },
      cache: 'no-store',
    });
    if (!response.ok) {
      return NextResponse.json({ sessions: [] });
    }
    const data = await response.json() as { sessions?: string[] };
    const sessions = (data.sessions ?? []).filter((session) => session.startsWith('cortex-dash-'));
    return NextResponse.json({ sessions });
  } catch {
    return NextResponse.json({ sessions: [] });
  }
}
