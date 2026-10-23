import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const failure = 'Could not subscribe. Please try again.';
function json(body: { ok: boolean; error?: string }, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Reuse the site's consented list without forwarding local credentials or context. */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as { email?: unknown } | null;
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ ok: false, error: 'Enter a valid email address.' }, 400);
  }

  try {
    const response = await fetch('https://o8.run/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, source: 'app' }),
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json().catch(() => null) as { ok?: unknown; reason?: unknown } | null;
    if (response.ok && result?.ok === true) return json({ ok: true });
    if (response.ok && result?.reason === 'not_configured') {
      return json({ ok: false, error: 'Signups are paused. Please try again later.' }, 503);
    }
    return json({ ok: false, error: failure }, 502);
  } catch {
    return json({ ok: false, error: failure }, 502);
  }
}
