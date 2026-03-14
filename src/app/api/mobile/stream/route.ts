/**
 * SSE streaming endpoint for mobile chat deltas.
 *
 * GET /api/mobile/stream?sessionKey=agent:main:main
 *
 * Pushes real-time chat deltas from the OpenClaw gateway to the browser
 * via Server-Sent Events. Falls back gracefully — if the gateway connection
 * drops, the client's existing polling catches up.
 *
 * Event format:
 *   event: chat-delta
 *   data: { state, text, runId, seq, timestamp }
 *
 *   event: chat-done
 *   data: { text, runId, seq, timestamp }
 *
 *   event: chat-error
 *   data: { error, runId }
 *
 *   event: ping
 *   data: { ts }
 */

import { NextRequest } from 'next/server';
import { type ChatDelta, getGatewayStream } from '@/lib/openclaw/gateway-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function extractText(delta: ChatDelta): string {
  if (!delta.message?.content) return delta.partialText ?? '';
  return delta.message.content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text ?? '')
    .join('');
}

export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim();
  if (!sessionKey) {
    return new Response(JSON.stringify({ error: 'sessionKey is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stream = getGatewayStream();

  // Create a readable stream that pushes SSE events
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const readable = new ReadableStream({
    start(controller) {
      // Send initial connection event
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ sessionKey, ts: Date.now() })}\n\n`),
      );

      // Send any buffered delta for this session (late-join catch-up)
      const buffered = stream.getLatestDelta(sessionKey);
      if (buffered) {
        const text = extractText(buffered);
        controller.enqueue(
          encoder.encode(
            `event: chat-delta\ndata: ${JSON.stringify({
              state: buffered.state,
              text,
              runId: buffered.runId,
              seq: buffered.seq,
              timestamp: buffered.message?.timestamp,
            })}\n\n`,
          ),
        );
      }

      // Subscribe to gateway chat events filtered to this session
      unsubscribe = stream.subscribe((delta) => {
        if (closed) return;
        if (delta.sessionKey !== sessionKey) return;

        try {
          const text = extractText(delta);

          if (delta.state === 'delta') {
            controller.enqueue(
              encoder.encode(
                `event: chat-delta\ndata: ${JSON.stringify({
                  state: 'delta',
                  text,
                  runId: delta.runId,
                  seq: delta.seq,
                  timestamp: delta.message?.timestamp,
                })}\n\n`,
              ),
            );
          } else if (delta.state === 'done') {
            controller.enqueue(
              encoder.encode(
                `event: chat-done\ndata: ${JSON.stringify({
                  text,
                  runId: delta.runId,
                  seq: delta.seq,
                  timestamp: delta.message?.timestamp,
                })}\n\n`,
              ),
            );
          } else if (delta.state === 'error' || delta.state === 'aborted') {
            controller.enqueue(
              encoder.encode(
                `event: chat-error\ndata: ${JSON.stringify({
                  state: delta.state,
                  error: delta.error ?? 'aborted',
                  runId: delta.runId,
                  partialText: delta.partialText,
                })}\n\n`,
              ),
            );
          }
        } catch {
          // Controller might be closed — ignore write errors
        }
      });

      // Keepalive ping every 15 seconds to prevent proxy/mobile timeouts
      pingTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: stream.connected })}\n\n`),
          );
        } catch {
          // Stream closed — cleanup will happen in cancel()
        }
      }, 15000);
    },

    cancel() {
      closed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
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
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  });
}
