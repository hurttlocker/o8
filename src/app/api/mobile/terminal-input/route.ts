export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { resolvePortInfo } from '@/lib/panel/api-port';

/**
 * POST /api/mobile/terminal-input   { sessionName, text, raw?:false }
 *
 * Type a line into a live PTY from the phone — direct operator intent, no confirm
 * gate. Thin loopback proxy to the ws-server's internal `/terminal-voice-input`.
 * Returns 404 when the named PTY no longer exists so the caller auto-detaches a
 * stale terminal scope instead of typing into the void. `raw:false` (the default)
 * appends the shell newline; `raw:true` writes the bytes verbatim. This CANONICAL
 * mobile route exists so the request can traverse the encrypted relay; direct
 * clients keep the WS-port fallback. Gated to operator + enrolled device by
 * src/middleware.ts. Never hardcodes a port (resolvePortInfo()).
 */
export async function POST(request: Request) {
  let payload: { sessionName?: unknown; text?: unknown; raw?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const sessionName = typeof payload.sessionName === 'string' ? payload.sessionName.trim() : '';
  const text = typeof payload.text === 'string' ? payload.text : '';
  const raw = payload.raw === true;
  if (!sessionName || !text) {
    return NextResponse.json({ error: 'sessionName and text are required' }, { status: 400 });
  }

  try {
    const wsToken = getOrCreateWsToken();
    const { wsPort } = resolvePortInfo();
    const response = await fetch(`http://127.0.0.1:${wsPort}/terminal-voice-input`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${wsToken}`,
      },
      body: JSON.stringify({ sessionName, text, raw }),
      cache: 'no-store',
    });
    // Forward 404 unchanged — the PTY is gone; the phone maps it to "gone" and
    // detaches the scope. Every other non-2xx is a generic write failure.
    if (response.status === 404) {
      return NextResponse.json({ error: 'session not found' }, { status: 404 });
    }
    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to write to terminal' }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to write to terminal' },
      { status: 500 },
    );
  }
}
