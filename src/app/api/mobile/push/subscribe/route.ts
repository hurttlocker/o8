/**
 * POST   /api/mobile/push/subscribe — store a PushSubscription
 * DELETE /api/mobile/push/subscribe — remove by endpoint
 *
 * Body shape (POST):
 *   {
 *     endpoint: string,
 *     keys: { p256dh: string, auth: string },
 *     userAgent?: string,
 *     label?: string,
 *     webhookUrl?: string,
 *   }
 *
 * Body shape (DELETE):
 *   { endpoint: string }
 *
 * Both routes are gated by the loopback + ws-token middleware.
 *
 * Issue: https://github.com/hurttlocker/o8/issues/639
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  upsertPushSubscription,
  deletePushSubscription,
  getPushSubscription,
} from '@/lib/push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SubscribeBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
  userAgent?: unknown;
  label?: unknown;
  webhookUrl?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function POST(req: NextRequest) {
  let body: SubscribeBody;
  try {
    body = await req.json() as SubscribeBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!isNonEmptyString(body.endpoint)) {
    return NextResponse.json({ error: 'endpoint is required.' }, { status: 400 });
  }
  if (!body.keys || !isNonEmptyString(body.keys.p256dh) || !isNonEmptyString(body.keys.auth)) {
    return NextResponse.json({ error: 'keys.p256dh and keys.auth are required.' }, { status: 400 });
  }

  try {
    const sub = upsertPushSubscription({
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: isNonEmptyString(body.userAgent) ? body.userAgent : null,
      label: isNonEmptyString(body.label) ? body.label : null,
      webhookUrl: isNonEmptyString(body.webhookUrl) ? body.webhookUrl : null,
    });

    if (!sub) {
      return NextResponse.json({ error: 'Database unavailable.' }, { status: 503 });
    }

    return NextResponse.json({ ok: true, endpoint: sub.endpoint });
  } catch (error) {
    console.error('[mobile/push/subscribe] failed to store subscription', error);
    return NextResponse.json({ error: 'Failed to store subscription.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  let body: { endpoint?: unknown } = {};
  try {
    body = await req.json() as { endpoint?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!isNonEmptyString(body.endpoint)) {
    return NextResponse.json({ error: 'endpoint is required.' }, { status: 400 });
  }

  try {
    const removed = deletePushSubscription(body.endpoint);
    return NextResponse.json({ ok: true, removed });
  } catch (error) {
    console.error('[mobile/push/subscribe] failed to delete subscription', error);
    return NextResponse.json({ error: 'Failed to delete subscription.' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  // Diagnostic — does this endpoint already have a subscription registered?
  const endpoint = req.nextUrl.searchParams.get('endpoint');
  if (!endpoint) {
    return NextResponse.json({ error: 'endpoint query param is required.' }, { status: 400 });
  }
  const sub = getPushSubscription(endpoint);
  return NextResponse.json({ subscribed: Boolean(sub) });
}
