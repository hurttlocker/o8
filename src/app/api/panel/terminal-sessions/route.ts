export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
const WS_PORT = Number(process.env.WS_PORT ?? 3002);
const WS_TOKEN = process.env.WS_TOKEN ?? 'cortex-ide';

/** GET — list alive dashboard terminal sessions owned by the WS bridge */
export async function GET() {
  try {
    const response = await fetch(`http://127.0.0.1:${WS_PORT}/terminal-sessions`, {
      headers: { Authorization: `Bearer ${WS_TOKEN}` },
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
