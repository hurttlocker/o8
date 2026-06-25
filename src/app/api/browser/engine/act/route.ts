export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getBrowserEngine } from '@/lib/browser-engine/engine';

/**
 * Human-interaction bridge for the engine live-view (auth-gated apps the iframe
 * can't embed). The panel's EnginePane forwards the operator's clicks / keys /
 * scroll — mapped into engine viewport coordinates — so they can drive the page
 * (sign in, navigate) inside the engine's real Chrome. Gated by middleware
 * (loopback + token, under /api/browser/).
 */

interface ActBody {
  scope?: unknown;
  action?: unknown;
  url?: unknown;
  x?: unknown;
  y?: unknown;
  text?: unknown;
  key?: unknown;
  deltaY?: unknown;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as ActBody | null;
  const scope = typeof body?.scope === 'string' && body.scope ? body.scope : 'operator';
  const action = typeof body?.action === 'string' ? body.action : '';
  const engine = getBrowserEngine();

  try {
    switch (action) {
      case 'open':
        return NextResponse.json(await engine.open(scope, typeof body?.url === 'string' ? body.url : ''));
      case 'close':
        return NextResponse.json(await engine.close(scope));
      case 'click':
        return NextResponse.json(await engine.clickAt(scope, num(body?.x), num(body?.y)));
      case 'type':
        return NextResponse.json(await engine.typeText(scope, typeof body?.text === 'string' ? body.text : ''));
      case 'press':
        return NextResponse.json(await engine.pressKey(scope, typeof body?.key === 'string' ? body.key : ''));
      case 'scroll':
        return NextResponse.json(await engine.scrollBy(scope, num(body?.deltaY)));
      default:
        return NextResponse.json({ ok: false, error: `unknown action: ${action || '(none)'}` }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'engine act failed' });
  }
}
