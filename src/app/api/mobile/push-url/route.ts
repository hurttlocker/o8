/**
 * POST /api/mobile/push-url
 *
 * Long-press a port chip on the desktop status bar, click "Send to mobile",
 * and the URL is fanned out to every connected mobile client over WS. The
 * mobile-split-shell listener consumes the broadcast and re-points the
 * DevHostFrame iframe to the new URL.
 *
 * Issue: https://github.com/hurttlocker/o8/issues/782
 *
 * Body:
 *   { url: string, sourceRepoId?: string | null }
 *
 * The URL is validated server-side: only LAN-style hosts are accepted
 * (loopback, RFC1918 private ranges, *.local / *.localhost). Anything else
 * is rejected with a 400 so a malicious caller can't push arbitrary
 * external pages onto a phone. The middleware additionally gates this
 * route on loopback / bearer token.
 *
 * On success, the WS server fans out a `mobile-dev-host` / `url-push`
 * event with payload `{ url, sentAt, sourceRepoId }`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { isLanDevHost } from '@/lib/mobile/lan-dev-host';
import { getWsBase } from '@/lib/panel/api-port';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REALTIME_INTERNAL_ORIGIN =
  process.env.CORTEX_REALTIME_INTERNAL_ORIGIN ?? getWsBase();
const REALTIME_INTERNAL_TIMEOUT_MS = 2_500;

interface PushUrlBody {
  url?: string;
  sourceRepoId?: string | null;
}

export async function POST(req: NextRequest) {
  let body: PushUrlBody;
  try {
    body = (await req.json()) as PushUrlBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body.' },
      { status: 400 },
    );
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) {
    return NextResponse.json(
      { ok: false, error: 'url is required.' },
      { status: 400 },
    );
  }

  if (!isLanDevHost(url)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Only LAN dev hosts can be pushed. Allowed: localhost, 127.0.0.1, 10.x, 172.16-31.x, 192.168.x, *.local, *.localhost.',
      },
      { status: 400 },
    );
  }

  const sourceRepoId =
    typeof body.sourceRepoId === 'string' && body.sourceRepoId.trim()
      ? body.sourceRepoId.trim()
      : null;
  const sentAt = new Date().toISOString();

  try {
    const response = await fetch(`${REALTIME_INTERNAL_ORIGIN}/internal/mobile-url-push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getOrCreateWsToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url, sourceRepoId, sentAt }),
      signal: AbortSignal.timeout(REALTIME_INTERNAL_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('[mobile/push-url] ws-server rejected push', response.status, detail);
      return NextResponse.json(
        { ok: false, error: 'Failed to broadcast URL to mobile clients.' },
        { status: 502 },
      );
    }

    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; recipients?: number }
      | null;
    const recipients =
      payload && typeof payload.recipients === 'number' ? payload.recipients : 0;

    return NextResponse.json({ ok: true, recipients, sentAt, url });
  } catch (error) {
    console.error('[mobile/push-url] internal fetch failed', error);
    return NextResponse.json(
      { ok: false, error: 'Realtime bridge unavailable.' },
      { status: 502 },
    );
  }
}
