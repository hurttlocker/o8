export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { buildTransportedToolEval } from '@/lib/mobile/symon-tool-eval';
import { getOrCreateWsToken } from '@/lib/ws-auth';

const POLL_MS = 100;
const TIMEOUT_MS = 125_000;

function client(): O8WebviewClient {
  const global = globalThis as { __o8SymonTransportClient?: O8WebviewClient };
  global.__o8SymonTransportClient ??= new O8WebviewClient();
  return global.__o8SymonTransportClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transportAuthorized(request: NextRequest): boolean {
  const auth = request.headers.get('authorization');
  const presented = Buffer.from(auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '', 'utf8');
  const expected = Buffer.from(getOrCreateWsToken().trim(), 'utf8');
  return presented.length > 0
    && presented.length === expected.length
    && timingSafeEqual(presented, expected);
}

export async function POST(request: NextRequest) {
  if (!transportAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'unauthorized', detail: 'Remote Symon transport authentication failed.' }, { status: 401 });
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  const callId = typeof body?.callId === 'string' ? body.callId.trim() : '';
  const tool = typeof body?.tool === 'string' ? body.tool.trim() : '';
  const args = body?.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  if (!sessionId || !callId || !tool) {
    return NextResponse.json({ ok: false, error: 'bad_request', detail: 'sessionId, callId, and tool are required' });
  }
  const code = buildTransportedToolEval(sessionId, callId, tool, args);
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const { result } = await client().evalJs(code);
      const parsed = JSON.parse(result) as { state?: string; ok?: boolean; result?: unknown };
      if (parsed.state === 'no_bridge') {
        return NextResponse.json({ ok: false, error: 'remote_unavailable', detail: 'The remote o8 desktop bridge is not mounted.' });
      }
      if (parsed.state === 'call_mismatch') {
        return NextResponse.json({ ok: false, error: 'call_mismatch', detail: 'The remote call id is already bound to another tool.' });
      }
      if (parsed.state === 'done') {
        return NextResponse.json({ ok: parsed.ok === true, result: parsed.result });
      }
      await sleep(POLL_MS);
    }
    return NextResponse.json({ ok: false, error: 'remote_timeout', detail: 'The remote tool did not finish before its execution deadline.' });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: 'remote_unavailable',
      detail: error instanceof Error ? error.message : 'The remote tool bridge failed.',
    });
  }
}
