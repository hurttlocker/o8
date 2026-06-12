export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getBrowserEngine } from '@/lib/browser-engine/engine';

/**
 * Live view of an engine browser session (#1232 phase 3) — the canvas
 * browser card polls this to show the agent's headless Chrome working.
 * Plain GET returns a jpeg frame (img-tag friendly; loopback passes the
 * middleware gate); `?meta=1` returns { active, url, title } for the tab
 * label without paying for a frame.
 */

export async function GET(request: NextRequest) {
  const scope = request.nextUrl.searchParams.get('scope') || 'operator';
  const engine = getBrowserEngine();

  if (request.nextUrl.searchParams.get('meta') === '1') {
    const meta = await engine.meta(scope).catch(() => ({ active: false as const }));
    return NextResponse.json({ ok: true, ...meta });
  }

  const frame = await engine.screenshot(scope).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : 'screenshot failed',
  }));
  if (!frame.ok) {
    return NextResponse.json({ ok: false, error: frame.error }, { status: 404 });
  }
  return new NextResponse(Buffer.from(frame.jpegBase64, 'base64'), {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'no-store',
    },
  });
}
