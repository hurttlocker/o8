export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getBrowserEngine } from '@/lib/browser-engine/engine';

/**
 * One-shot proof capture for `o8 packet capture` (#1648). The CLI used to
 * spawn the external dev-browser CLI, which ENOENTs on any machine without
 * the tool installed; captures now run on o8's own headless engine, so a
 * fresh install needs nothing beyond Chrome. Gated by middleware (loopback +
 * token, under /api/browser/).
 */

interface CaptureBody {
  url?: unknown;
  waitFor?: unknown;
  hover?: unknown;
  click?: unknown;
  clip?: unknown;
  settleMs?: unknown;
  fullPage?: unknown;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as CaptureBody | null;
  const url = str(body?.url);
  if (!url) {
    return NextResponse.json({ ok: false, error: 'capture requires a url' }, { status: 400 });
  }
  const result = await getBrowserEngine().capture({
    url,
    waitFor: str(body?.waitFor),
    hover: str(body?.hover),
    click: str(body?.click),
    clip: str(body?.clip),
    settleMs: typeof body?.settleMs === 'number' && Number.isFinite(body.settleMs) ? Math.max(0, Math.min(10_000, body.settleMs)) : 0,
    fullPage: body?.fullPage === true,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
