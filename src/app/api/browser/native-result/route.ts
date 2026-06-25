export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveNativeResult } from '@/lib/browser/native-result-registry';

/**
 * Secure result sink for the native browser-view channel (Stage 4).
 *
 * The injected `__o8BrowserAgent` verb, running in the untrusted browser-view
 * page, POSTs its result here (cross-origin no-cors `text/plain`, so the body
 * arrives without a CORS preflight) keyed by the correlation id o8 handed it.
 * This is the ONLY thing the page can do back to o8 — it can't read secrets or
 * call host commands, because the page has no Tauri IPC bridge. A POST from the
 * webview originates on loopback, so it passes the middleware gate without a
 * token; a wrong/late cid resolves nothing.
 */
export async function POST(request: NextRequest) {
  const raw = await request.text().catch(() => '');
  let body: { cid?: unknown; payload?: unknown } | null = null;
  try {
    body = JSON.parse(raw) as { cid?: unknown; payload?: unknown };
  } catch {
    body = null;
  }
  const cid = typeof body?.cid === 'string' ? body.cid : '';
  if (!cid) {
    return NextResponse.json({ ok: false, error: 'missing cid' }, { status: 400 });
  }
  const resolved = resolveNativeResult(cid, body?.payload ?? null);
  return NextResponse.json({ ok: resolved });
}
