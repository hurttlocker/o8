/**
 * SSE streaming endpoint for mobile chat deltas.
 *
 * Live chat updates come from the shared websocket server now. This endpoint
 * stays available as a lightweight heartbeat so older clients fail softly.
 */

import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim();
  if (!sessionKey) {
    return new Response(JSON.stringify({ error: 'sessionKey is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ sessionKey, ts: Date.now(), connected: false })}\n\n`),
      );

      pingTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: false })}\n\n`),
          );
        } catch {
          // ignore stream closure races
        }
      }, 15000);
    },
    cancel() {
      closed = true;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
