export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { buildMachineSessionEndEval } from '@/lib/mobile/symon-tool-eval';

const POLL_MS = 50;
const TIMEOUT_MS = 5_000;

function client(): O8WebviewClient {
  const global = globalThis as { __o8SymonMachineSessionClient?: O8WebviewClient };
  global.__o8SymonMachineSessionClient ??= new O8WebviewClient();
  return global.__o8SymonMachineSessionClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { sessionId?: unknown } | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId || sessionId.length > 160) {
    return NextResponse.json(
      { ok: false, error: 'bad_request', detail: 'A bounded sessionId is required.' },
      { status: 400 },
    );
  }

  const code = buildMachineSessionEndEval(sessionId);
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const { result } = await client().evalJs(code);
      const parsed = JSON.parse(result) as {
        state?: string;
        removed?: boolean;
        detail?: string;
      };
      if (parsed.state === 'no_bridge') {
        return NextResponse.json(
          { ok: false, error: 'desktop_unavailable', detail: 'The Symon machine bridge is not mounted.' },
          { status: 503 },
        );
      }
      if (parsed.state === 'error') {
        return NextResponse.json(
          { ok: false, error: 'cleanup_failed', detail: parsed.detail || 'Machine-session cleanup failed.' },
          { status: 502 },
        );
      }
      if (parsed.state === 'done') {
        return NextResponse.json({ ok: true, removed: parsed.removed === true });
      }
      await sleep(POLL_MS);
    }
    return NextResponse.json(
      { ok: false, error: 'cleanup_timeout', detail: 'Machine-session cleanup timed out.' },
      { status: 504 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: 'desktop_unavailable',
        detail: error instanceof Error ? error.message : 'Machine-session cleanup bridge failed.',
      },
      { status: 503 },
    );
  }
}
