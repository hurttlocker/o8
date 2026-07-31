export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { buildSymonTextInterruptEval, buildSymonTextTurnEval } from '@/lib/mobile/symon-text-eval';

const POLL_INTERVAL_MS = 150;
const POLL_WINDOW_MS = 3_000;

function webviewClient(): O8WebviewClient {
  const global = globalThis as { __o8SymonTextClient?: O8WebviewClient };
  global.__o8SymonTextClient ??= new O8WebviewClient();
  return global.__o8SymonTextClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollEval(code: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + POLL_WINDOW_MS;
  while (Date.now() < deadline) {
    const { result } = await webviewClient().evalJs(code);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (parsed.state !== 'pending') return parsed;
    await sleep(POLL_INTERVAL_MS);
  }
  return { state: 'pending' };
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const turnId = typeof body?.turnId === 'string' ? body.turnId : '';
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
  if (!sessionId || !turnId || !prompt) {
    return NextResponse.json({ ok: false, state: 'error', error: 'bad_request' }, { status: 400 });
  }
  try {
    const result = await pollEval(buildSymonTextTurnEval(sessionId, turnId, prompt));
    return NextResponse.json({ ok: result.state !== 'error', ...result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      state: 'error',
      error: 'desktop_unavailable',
      detail: error instanceof Error ? error.message : 'Webview bridge failed.',
    });
  }
}

export async function DELETE(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const turnId = typeof body?.turnId === 'string' ? body.turnId : '';
  if (!sessionId || !turnId) {
    return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
  }
  try {
    const result = await pollEval(buildSymonTextInterruptEval(sessionId, turnId));
    return NextResponse.json({ ok: result.state === 'done', ...result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      state: 'error',
      error: 'desktop_unavailable',
      detail: error instanceof Error ? error.message : 'Webview bridge failed.',
    }, { status: 503 });
  }
}
