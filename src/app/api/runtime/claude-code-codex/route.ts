import { NextRequest, NextResponse } from 'next/server';

import {
  getCodexSubscriptionProxyStatus,
  startCodexSubscriptionProxyLogin,
} from '@/lib/claude-code/codex-subscription-proxy';
import { requirePanelAuth } from '@/lib/panel/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  return NextResponse.json({ ok: true, status: await getCodexSubscriptionProxyStatus() }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as { action?: unknown } | null;
  if (body?.action !== 'connect') {
    return NextResponse.json({ ok: false, error: 'action must be "connect".' }, { status: 400 });
  }
  try {
    const status = await startCodexSubscriptionProxyLogin();
    return NextResponse.json({ ok: true, status }, {
      status: status.authenticated ? 200 : 202,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'The Codex subscription connection could not start.',
    }, { status: 409 });
  }
}
