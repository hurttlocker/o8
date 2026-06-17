import { NextResponse } from 'next/server';

import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';
import { readCachedEntitlement } from '@/lib/entitlement/license';

export const dynamic = 'force-dynamic';

/**
 * POST /api/panel/telemetry — coarse product-event emit (analytics epic #1249).
 *
 * The client fires `{ event, props }`; this reads THIS install's account token
 * from entitlement.json and forwards to the license server's /v1/telemetry with
 * it as bearer (the token never reaches the browser). No token → no-op. COARSE
 * ONLY: event name capped, props must be a small plain object — never code or
 * content. Loopback+token gated via the '/api/panel/' prefix. Telemetry must
 * never break the app, so every failure is swallowed into a soft response.
 */
export async function POST(request: Request) {
  try {
    const token = readCachedEntitlement()?.licenseKey?.trim();
    if (!token) return NextResponse.json({ ok: false, reason: 'no account token' });

    const body = (await request.json().catch(() => ({}))) as { event?: unknown; props?: unknown };
    const event = typeof body.event === 'string' ? body.event.trim().slice(0, 80) : '';
    if (!event) return NextResponse.json({ ok: false, reason: 'no event' });

    const props =
      body.props && typeof body.props === 'object' && !Array.isArray(body.props)
        ? (body.props as Record<string, unknown>)
        : undefined;

    // Forward with a short timeout so a slow upstream never hangs the route.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      await fetch(`${proxyBaseUrl()}/v1/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ event, props }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
