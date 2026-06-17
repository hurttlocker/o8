import { NextResponse } from 'next/server';

import { emitProductEvent } from '@/lib/analytics/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/panel/telemetry — coarse product-event emit (analytics epic #1249).
 *
 * The client fires `{ event, props }`; this validates the untrusted shape and
 * hands it to emitProductEvent(), which attaches THIS install's account token
 * and forwards to the license server (the token never reaches the browser). No
 * token → no-op. COARSE ONLY: event name capped, props must be a small plain
 * object — never code or content. Loopback+token gated via the '/api/panel/'
 * prefix. Telemetry must never break the app, so every failure is swallowed.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { event?: unknown; props?: unknown };
    const event = typeof body.event === 'string' ? body.event.trim().slice(0, 80) : '';
    if (!event) return NextResponse.json({ ok: false, reason: 'no event' });

    const props =
      body.props && typeof body.props === 'object' && !Array.isArray(body.props)
        ? (body.props as Record<string, unknown>)
        : undefined;

    await emitProductEvent(event, props);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
